import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { api, ApiError, type ActiveTrip, type Connection, type TripSummary, type User } from "./api";
import {
  applyOps,
  DEFAULT_LISTS,
  DEFAULT_SECTIONS,
  HOUSEHOLD_LIST,
  type Author,
  type Item,
  type ItemPayload,
  type ListState,
  type Op,
  type Source,
} from "./ops";
import { loadToken, saveToken } from "./session";

export type SyncStatus = "signedOut" | "syncing" | "ok" | "offline" | "unauthorized" | "error";

export interface NewItem {
  name: string;
  sectionId: string;
  qty?: number;
  brand?: string | null;
  size?: string | null;
  barcode?: string | null;
}

interface Store extends ListState {
  serverUrl: string;
  /** Kept in the Keychain; loaded into memory at startup, never persisted here. */
  token: string | null;
  tokenLoaded: boolean;
  user: User | null;
  currentListId: string;
  outbox: Op[];
  lastSyncAt: number | null;
  status: SyncStatus;
  collapsed: Record<string, boolean>;
  activeTrips: ActiveTrip[];
  /** Setup token saved by the first version of the app; traded for a personal token on upgrade. */
  legacySetupToken: string | null;
  legacyName: string | null;

  connection(): Connection;
  signIn(serverUrl: string, token: string, user: User): Promise<void>;
  signOut(): Promise<void>;
  loadSession(): Promise<void>;

  addItems(items: NewItem[], source: Source): void;
  toggle(id: string): void;
  updateItem(id: string, patch: Partial<ItemPayload>): void;
  removeItem(id: string): void;
  clearDone(): void;
  reorderSections(order: string[]): void;
  toggleCollapsed(sectionId: string): void;

  setCurrentList(id: string): void;
  createList(name: string, isPrivate: boolean): string;
  renameList(id: string, name: string): void;
  deleteList(id: string): void;

  myTrip(): ActiveTrip | null;
  startTrip(): Promise<void>;
  finishTrip(): Promise<TripSummary | null>;

  sync(): Promise<void>;
}

const payload = ({ createdAt: _c, updatedAt: _u, addedBy: _a, addedById: _i, ...rest }: Item): ItemPayload => rest;

const EMPTY = { lists: DEFAULT_LISTS, sections: DEFAULT_SECTIONS, items: [] as Item[] };

let syncing: Promise<void> | null = null;

export const useStore = create<Store>()(
  persist(
    (set, get) => {
      const author = (): Author => ({ id: get().user?.id ?? null, name: get().user?.name ?? null });

      // Apply locally now, queue for the server, and kick off a sync.
      const dispatch = (ops: Op[]) => {
        set((s) => ({ ...applyOps(s, ops, author()), outbox: [...s.outbox, ...ops] }));
        void get().sync();
      };

      return {
        ...EMPTY,
        serverUrl: "",
        token: null,
        tokenLoaded: false,
        user: null,
        currentListId: HOUSEHOLD_LIST,
        outbox: [],
        lastSyncAt: null,
        status: "signedOut",
        collapsed: {},
        activeTrips: [],
        legacySetupToken: null,
        legacyName: null,

        connection: () => ({ serverUrl: get().serverUrl, token: get().token }),

        async signIn(serverUrl, token, user) {
          await saveToken(token);
          set({ serverUrl, token, user, status: "syncing", legacySetupToken: null, legacyName: null });
          await get().sync();
        },

        async signOut() {
          await api.logout(get().connection()).catch(() => {});
          await saveToken(null);
          set({ ...EMPTY, token: null, user: null, outbox: [], lastSyncAt: null, status: "signedOut", activeTrips: [], currentListId: HOUSEHOLD_LIST });
        },

        async loadSession() {
          const token = await loadToken();
          // Upgrading from the shared-token version: quietly swap the old secret for a personal login
          // before any screen decides whether to show the welcome screen.
          const { legacySetupToken, legacyName, serverUrl } = get();
          if (!token && legacySetupToken && serverUrl) {
            try {
              const res = await api.setup({ serverUrl, token: null }, legacySetupToken, legacyName || "Me");
              await saveToken(res.token);
              set({ token: res.token, user: res.user, legacySetupToken: null, legacyName: null, tokenLoaded: true });
              return;
            } catch {
              // Leave it to the welcome screen.
            }
          }
          set({ token, tokenLoaded: true, status: token ? get().status : "signedOut" });
        },

        addItems(items, source) {
          const at = Date.now();
          const listId = get().currentListId;
          dispatch(
            items.map((n) => ({
              type: "item.upsert" as const,
              at,
              item: {
                id: randomUUID(),
                listId,
                name: n.name.trim(),
                brand: n.brand?.trim() || null,
                size: n.size?.trim() || null,
                qty: Math.max(1, Math.min(99, n.qty ?? 1)),
                sectionId: n.sectionId,
                done: false,
                source,
                barcode: n.barcode ?? null,
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
          dispatch([{ type: "items.clearDone", at: Date.now(), listId: get().currentListId }]);
        },

        reorderSections(order) {
          dispatch([{ type: "sections.reorder", at: Date.now(), order }]);
        },

        toggleCollapsed(sectionId) {
          set((s) => ({ collapsed: { ...s.collapsed, [sectionId]: !s.collapsed[sectionId] } }));
        },

        setCurrentList(id) {
          set({ currentListId: id });
        },

        createList(name, isPrivate) {
          const id = randomUUID();
          dispatch([{ type: "list.upsert", at: Date.now(), list: { id, name: name.trim(), private: isPrivate } }]);
          set({ currentListId: id });
          return id;
        },

        renameList(id, name) {
          const list = get().lists.find((l) => l.id === id);
          if (list) dispatch([{ type: "list.upsert", at: Date.now(), list: { id, name: name.trim(), private: list.private } }]);
        },

        deleteList(id) {
          dispatch([{ type: "list.delete", at: Date.now(), id }]);
          if (get().currentListId === id) set({ currentListId: HOUSEHOLD_LIST });
        },

        myTrip() {
          const { activeTrips, user, currentListId } = get();
          return activeTrips.find((t) => t.userId === user?.id && t.listId === currentListId) ?? null;
        },

        async startTrip() {
          const { user, currentListId } = get();
          if (!user) return;
          // Push pending ticks first so they don't land on the new trip.
          await get().sync();
          const trip = await api.startTrip(get().connection(), currentListId);
          set((s) => ({
            activeTrips: [
              ...s.activeTrips.filter((t) => !(t.userId === user.id && t.listId === currentListId)),
              { id: trip.id, listId: currentListId, userId: user.id, name: user.name, startedAt: trip.startedAt, ticked: 0 },
            ],
          }));
        },

        async finishTrip() {
          const trip = get().myTrip();
          if (!trip) return null;
          // Make sure every tick from the shop has reached the server before closing the trip.
          await get().sync();
          const summary = await api.finishTrip(get().connection(), trip.id);
          set((s) => ({ activeTrips: s.activeTrips.filter((t) => t.id !== trip.id) }));
          return summary;
        },

        sync() {
          // One sync at a time; callers during a sync share its result.
          if (syncing) return syncing;
          syncing = (async () => {
            const { serverUrl, token, outbox } = get();
            if (!serverUrl || !token) {
              set({ status: "signedOut" });
              return;
            }
            const sent = outbox.length;
            set({ status: "syncing" });
            try {
              const server = await api.sync({ serverUrl, token }, outbox.slice(0, sent));
              // Anything queued while the request was in flight is replayed over the server's state.
              set((s) => {
                const pending = s.outbox.slice(sent);
                const base: ListState = { lists: server.lists, sections: server.sections, items: server.items };
                const next = applyOps(base, pending, author());
                const listStillThere = next.lists.some((l) => l.id === s.currentListId);
                return {
                  ...next,
                  activeTrips: server.activeTrips,
                  outbox: pending,
                  lastSyncAt: Date.now(),
                  status: "ok",
                  currentListId: listStillThere ? s.currentListId : HOUSEHOLD_LIST,
                };
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
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        lists: s.lists,
        sections: s.sections,
        items: s.items,
        serverUrl: s.serverUrl,
        user: s.user,
        currentListId: s.currentListId,
        outbox: s.outbox,
        lastSyncAt: s.lastSyncAt,
        collapsed: s.collapsed,
        activeTrips: s.activeTrips,
        legacySetupToken: s.legacySetupToken,
        legacyName: s.legacyName,
      }),
      migrate(persisted, version) {
        const old = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) {
          // v1 kept one shared token in settings and had no lists. Ops queued by v1 still apply:
          // the server defaults them to the household list.
          const settings = (old.settings ?? {}) as { serverUrl?: string; token?: string; name?: string };
          const items = ((old.items as Item[] | undefined) ?? []).map((i) => ({ ...i, listId: i.listId ?? HOUSEHOLD_LIST, addedById: null }));
          return {
            ...old,
            items,
            lists: DEFAULT_LISTS,
            serverUrl: settings.serverUrl ?? "",
            legacySetupToken: settings.token || null,
            legacyName: settings.name || null,
            currentListId: HOUSEHOLD_LIST,
            activeTrips: [],
            user: null,
          } as never;
        }
        return old as never;
      },
    },
  ),
);
