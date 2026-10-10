import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { api, ApiError, type Settings } from "./api";
import { applyOp, applyOps, DEFAULT_SECTIONS, type Item, type ItemPayload, type ListState, type Op, type Source } from "./ops";

export type SyncStatus = "unconfigured" | "syncing" | "ok" | "offline" | "unauthorized" | "error";

export interface NewItem {
  name: string;
  sectionId: string;
  qty?: number;
  brand?: string | null;
  size?: string | null;
  barcode?: string | null;
}

interface Store extends ListState {
  settings: Settings;
  outbox: Op[];
  lastSyncAt: number | null;
  status: SyncStatus;
  collapsed: Record<string, boolean>;

  addItems(items: NewItem[], source: Source): void;
  toggle(id: string): void;
  updateItem(id: string, patch: Partial<ItemPayload>): void;
  removeItem(id: string): void;
  clearDone(): void;
  reorderSections(order: string[]): void;
  toggleCollapsed(sectionId: string): void;
  setSettings(patch: Partial<Settings>): void;
  sync(): Promise<void>;
}

const payload = ({ createdAt: _c, updatedAt: _u, ...rest }: Item): ItemPayload => rest;

let syncing: Promise<void> | null = null;

export const useStore = create<Store>()(
  persist(
    (set, get) => {
      // Apply locally now, queue for the server, and kick off a sync.
      const dispatch = (ops: Op[]) => {
        set((s) => ({ ...applyOps(s, ops), outbox: [...s.outbox, ...ops] }));
        void get().sync();
      };

      return {
        sections: DEFAULT_SECTIONS,
        items: [],
        settings: { serverUrl: "", token: "", name: "" },
        outbox: [],
        lastSyncAt: null,
        status: "unconfigured",
        collapsed: {},

        addItems(items, source) {
          const at = Date.now();
          const addedBy = get().settings.name.trim() || null;
          dispatch(
            items.map((n) => ({
              type: "item.upsert" as const,
              at,
              item: {
                id: randomUUID(),
                name: n.name.trim(),
                brand: n.brand?.trim() || null,
                size: n.size?.trim() || null,
                qty: Math.max(1, Math.min(99, n.qty ?? 1)),
                sectionId: n.sectionId,
                done: false,
                source,
                barcode: n.barcode ?? null,
                addedBy,
              },
            })),
          );
        },

        toggle(id) {
          const item = get().items.find((i) => i.id === id);
          if (item) dispatch([{ type: "item.upsert", at: Date.now(), item: { ...payload(item), done: !item.done } }]);
        },

        updateItem(id, patch) {
          const item = get().items.find((i) => i.id === id);
          if (item) dispatch([{ type: "item.upsert", at: Date.now(), item: { ...payload(item), ...patch, id } }]);
        },

        removeItem(id) {
          dispatch([{ type: "item.delete", at: Date.now(), id }]);
        },

        clearDone() {
          dispatch([{ type: "items.clearDone", at: Date.now() }]);
        },

        reorderSections(order) {
          dispatch([{ type: "sections.reorder", at: Date.now(), order }]);
        },

        toggleCollapsed(sectionId) {
          set((s) => ({ collapsed: { ...s.collapsed, [sectionId]: !s.collapsed[sectionId] } }));
        },

        setSettings(patch) {
          set((s) => ({ settings: { ...s.settings, ...patch } }));
        },

        sync() {
          // One sync at a time; callers during a sync share its result.
          if (syncing) return syncing;
          syncing = (async () => {
            const { settings, outbox } = get();
            if (!settings.serverUrl.trim()) {
              set({ status: "unconfigured" });
              return;
            }
            const sent = outbox.length;
            set({ status: "syncing" });
            try {
              const server = await api.sync(settings, outbox.slice(0, sent));
              // Anything queued while the request was in flight is replayed over the server's state.
              set((s) => {
                const pending = s.outbox.slice(sent);
                const base: ListState = { sections: server.sections, items: server.items };
                return { ...applyOps(base, pending), outbox: pending, lastSyncAt: Date.now(), status: "ok" };
              });
            } catch (err) {
              const status: SyncStatus =
                err instanceof ApiError && err.status === 401 ? "unauthorized" : err instanceof ApiError && err.status === 0 ? "offline" : "error";
              set({ status });
            }
          })().finally(() => {
            syncing = null;
            // Changes made mid-sync go up straight away rather than waiting for the next poll.
            const s = get();
            if (s.status === "ok" && s.outbox.length > 0) void s.sync();
          });
          return syncing;
        },
      };
    },
    {
      name: "shopping-list",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        sections: s.sections,
        items: s.items,
        settings: s.settings,
        outbox: s.outbox,
        lastSyncAt: s.lastSyncAt,
        collapsed: s.collapsed,
      }),
    },
  ),
);

export { applyOp };
