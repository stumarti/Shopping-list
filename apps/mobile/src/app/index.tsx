import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Icon, IconButton, s as ui, type IconName } from "../components/ui";
import { api } from "../lib/api";
import { groupItems, itemDetail, type Item } from "../lib/ops";
import { useStore, type SyncStatus } from "../lib/store";
import { avatarColor, colors, initial, radius } from "../lib/theme";

const SOURCE_ICON: Record<Item["source"], IconName> = { scan: "barcode-outline", photo: "camera-outline", text: "create-outline" };

function syncLabel(status: SyncStatus, lastSyncAt: number | null, waiting: number): string {
  switch (status) {
    case "unconfigured":
      return "Not connected · tap to set up";
    case "syncing":
      return "Syncing…";
    case "unauthorized":
      return "Server rejected the token";
    case "offline":
    case "error":
      return waiting ? `Offline · ${waiting} change${waiting === 1 ? "" : "s"} waiting` : "Offline";
    case "ok": {
      if (!lastSyncAt) return "Synced";
      const mins = Math.floor((Date.now() - lastSyncAt) / 60000);
      return mins < 1 ? "Synced just now" : `Synced ${mins} min ago`;
    }
  }
}

export default function ListScreen() {
  const insets = useSafeAreaInsets();
  const sections = useStore((st) => st.sections);
  const items = useStore((st) => st.items);
  const collapsed = useStore((st) => st.collapsed);
  const status = useStore((st) => st.status);
  const lastSyncAt = useStore((st) => st.lastSyncAt);
  const outbox = useStore((st) => st.outbox.length);
  const me = useStore((st) => st.settings.name);
  const { toggle, toggleCollapsed, clearDone, addItems } = useStore.getState();

  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const groups = useMemo(() => groupItems({ sections, items }), [sections, items]);
  const total = items.length;
  const left = items.filter((i) => !i.done).length;
  const doneCount = total - left;
  const ok = status === "ok" || status === "syncing";

  async function submit() {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      // The server splits "2L milk, bread" into items and picks aisles.
      const { items: parsed } = await api.parse(useStore.getState().settings, text);
      addItems(parsed, "text");
    } catch {
      // Offline: keep it simple and file it under Other; long-press to move it later.
      addItems([{ name: text.charAt(0).toUpperCase() + text.slice(1), sectionId: "other" }], "text");
    } finally {
      setDraft("");
      setAdding(false);
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={{ gap: 2 }}>
            <Text style={styles.eyebrow}>Shared list</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Shopping
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <IconButton icon="swap-vertical" label="Change aisle order" onPress={() => router.push("/aisles")} />
            <IconButton icon="people-outline" label="Sharing and sync" onPress={() => router.push("/settings")} />
          </View>
        </View>

        <View style={styles.statusRow}>
          <Pressable accessibilityRole="button" onPress={() => router.push("/settings")} style={styles.statusPress}>
            <View style={[styles.statusDot, { backgroundColor: ok ? colors.accent : status === "unconfigured" ? colors.faint : "#C2571A" }]} />
            <Text style={styles.statusStrong}>{total ? `${left} of ${total} left` : "Empty list"}</Text>
            <Text style={styles.statusText}>· {syncLabel(status, lastSyncAt, outbox)}</Text>
          </Pressable>
          {doneCount > 0 ? (
            <Pressable accessibilityRole="button" onPress={clearDone} hitSlop={8}>
              <Text style={styles.clear}>Clear ticked</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.addRow}>
          <TextInput
            accessibilityLabel="Add an item"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            placeholder="Add an item, e.g. 2 L milk, bread"
            placeholderTextColor={colors.faint}
            returnKeyType="done"
            style={[ui.input, styles.addInput]}
            editable={!adding}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Add item" onPress={submit} style={styles.addButton}>
            {adding ? <ActivityIndicator color="#FFFFFF" /> : <Icon name="add" color="#FFFFFF" />}
          </Pressable>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        {groups.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing on the list</Text>
            <Text style={styles.emptyText}>Scan a barcode, snap a photo, or type above.</Text>
          </View>
        ) : null}

        {groups.map(({ section, items: list, left: groupLeft }) => {
          const open = !collapsed[section.id];
          return (
            <View key={section.id} style={{ gap: 6 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                onPress={() => toggleCollapsed(section.id)}
                style={styles.groupHeader}
              >
                <View style={[ui.dot, { backgroundColor: section.color }]} />
                <Text style={styles.groupName}>{section.name}</Text>
                <Text style={styles.groupLeft}>{groupLeft === 0 ? "All in basket" : `${groupLeft} left`}</Text>
                <View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
                  <Icon name="chevron-down" size={18} color={colors.muted} />
                </View>
              </Pressable>

              {open ? (
                <View style={ui.card}>
                  {list.map((item, i) => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: item.done }}
                      accessibilityHint="Long press to edit"
                      onPress={() => {
                        void Haptics.selectionAsync();
                        toggle(item.id);
                      }}
                      onLongPress={() => router.push({ pathname: "/item/[id]", params: { id: item.id } })}
                      style={({ pressed }) => [styles.row, i > 0 && styles.rowBorder, pressed && { backgroundColor: "#F7F8F5" }]}
                    >
                      {item.done ? (
                        <View style={styles.checked}>
                          <Icon name="checkmark" size={17} color="#FFFFFF" />
                        </View>
                      ) : (
                        <View style={styles.unchecked} />
                      )}
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={[styles.itemName, item.done && styles.itemDone]}>{item.name}</Text>
                        {itemDetail(item) ? <Text style={styles.itemMeta}>{itemDetail(item)}</Text> : null}
                      </View>
                      <Icon name={SOURCE_ICON[item.source]} size={16} color={colors.faint} />
                      <View
                        accessibilityLabel={item.addedBy && item.addedBy !== me ? `Added by ${item.addedBy}` : "Added by you"}
                        style={[styles.avatar, { backgroundColor: avatarColor(item.addedBy, me) }]}
                      >
                        <Text style={styles.avatarText}>{initial(item.addedBy ?? me)}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
        <Button label="Scan barcode" icon="barcode-outline" onPress={() => router.push("/scan")} style={{ flex: 1 }} />
        <Button label="Photo" icon="camera-outline" variant="secondary" onPress={() => router.push("/photo")} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  header: { paddingHorizontal: 20, paddingBottom: 12, gap: 12 },
  titleRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  eyebrow: { fontSize: 13, fontWeight: "600", color: colors.muted },
  title: { fontSize: 34, fontWeight: "800", letterSpacing: -0.6, color: colors.ink },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  statusPress: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minHeight: 28 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusStrong: { fontSize: 14, fontWeight: "600", color: colors.ink },
  statusText: { fontSize: 14, color: colors.muted, flexShrink: 1 },
  clear: { fontSize: 14, fontWeight: "700", color: colors.accent },
  addRow: { flexDirection: "row", gap: 8 },
  addInput: { flex: 1, height: 48, borderRadius: 14, paddingHorizontal: 16 },
  addButton: { width: 48, height: 48, borderRadius: 14, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 14 },
  empty: { paddingVertical: 60, alignItems: "center", gap: 6 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: colors.ink },
  emptyText: { fontSize: 15, color: colors.muted },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 6 },
  groupName: { fontSize: 18, fontWeight: "700", color: colors.ink, letterSpacing: -0.2 },
  groupLeft: { marginLeft: "auto", fontSize: 13, color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60, backgroundColor: colors.surface },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.lineSoft },
  checked: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  unchecked: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: colors.unchecked },
  itemName: { fontSize: 16, fontWeight: "600", color: colors.ink },
  itemDone: { textDecorationLine: "line-through", color: colors.doneText },
  itemMeta: { fontSize: 13, color: colors.muted },
  avatar: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 11, fontWeight: "700", color: colors.ink },
  bottomBar: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
});
