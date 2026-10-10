import * as Haptics from "expo-haptics";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Icon, IconButton, s as ui, type IconName } from "../components/ui";
import { api, type Suggestion } from "../lib/api";
import { groupItems, itemDetail, type Item } from "../lib/ops";
import { useStore, type SyncStatus } from "../lib/store";
import { avatarColor, colors, initial, radius } from "../lib/theme";

const SOURCE_ICON: Record<Item["source"], IconName> = { scan: "barcode-outline", photo: "camera-outline", text: "create-outline" };

function syncLabel(status: SyncStatus, lastSyncAt: number | null, waiting: number): string {
  switch (status) {
    case "signedOut":
      return "Not signed in";
    case "syncing":
      return "Syncing…";
    case "unauthorized":
      return "Signed out by the server";
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

function minutesSince(t: number): string {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? "just now" : `${m} min`;
}

export default function ListScreen() {
  const insets = useSafeAreaInsets();
  const tokenLoaded = useStore((st) => st.tokenLoaded);
  const token = useStore((st) => st.token);
  const lists = useStore((st) => st.lists);
  const listId = useStore((st) => st.currentListId);
  const sections = useStore((st) => st.sections);
  const allItems = useStore((st) => st.items);
  const collapsed = useStore((st) => st.collapsed);
  const status = useStore((st) => st.status);
  const lastSyncAt = useStore((st) => st.lastSyncAt);
  const outbox = useStore((st) => st.outbox.length);
  const user = useStore((st) => st.user);
  const activeTrips = useStore((st) => st.activeTrips);
  const { toggle, toggleCollapsed, clearDone, addItems } = useStore.getState();

  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [tripBusy, setTripBusy] = useState(false);
  const [usual, setUsual] = useState<Suggestion[]>([]);

  const list = lists.find((l) => l.id === listId) ?? lists[0];
  const items = useMemo(() => allItems.filter((i) => i.listId === listId), [allItems, listId]);
  const groups = useMemo(() => groupItems(sections, items), [sections, items]);
  const total = items.length;
  const left = items.filter((i) => !i.done).length;
  const doneCount = total - left;
  const ok = status === "ok" || status === "syncing";
  const myTrip = activeTrips.find((t) => t.userId === user?.id && t.listId === listId);
  const othersShopping = activeTrips.filter((t) => t.userId !== user?.id && t.listId === listId);
  const ticked = myTrip ? Math.max(myTrip.ticked, 0) : 0;

  // "Usual items" refresh whenever you come back to the list or switch lists.
  const onList = useMemo(() => new Set(items.map((i) => i.name.toLowerCase())), [items]);
  useFocusEffect(
    useCallback(() => {
      if (!token) return;
      let live = true;
      api
        .suggestions(useStore.getState().connection(), listId)
        .then((r) => live && setUsual(r.suggestions))
        .catch(() => live && setUsual([]));
      return () => {
        live = false;
      };
    }, [listId, token]),
  );

  if (!tokenLoaded) return <View style={styles.root} />;
  if (!token) return <Redirect href="/welcome" />;

  async function submit() {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      // The server splits "2L milk, bread" into items and picks aisles.
      const { items: parsed } = await api.parse(useStore.getState().connection(), text);
      addItems(parsed, "text");
    } catch {
      // Offline: keep it simple and file it under Other; long-press to move it later.
      addItems([{ name: text.charAt(0).toUpperCase() + text.slice(1), sectionId: "other" }], "text");
    } finally {
      setDraft("");
      setAdding(false);
    }
  }

  async function startTrip() {
    setTripBusy(true);
    try {
      await useStore.getState().startTrip();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert("Can't start a trip", "Your home server isn't reachable right now. You can still tick things off; they'll sync later.");
    } finally {
      setTripBusy(false);
    }
  }

  async function finishTrip() {
    setTripBusy(true);
    try {
      const summary = await useStore.getState().finishTrip();
      const n = summary?.items.length ?? 0;
      Alert.alert(
        "Shopping done",
        n ? `${n} item${n === 1 ? "" : "s"} bought. They're saved in Past trips.` : "Nothing was ticked on this trip.",
        doneCount ? [{ text: "Keep ticked" }, { text: "Clear ticked", onPress: clearDone }] : [{ text: "OK" }],
      );
    } catch {
      Alert.alert("Couldn't finish the trip", "Your home server isn't reachable. Try again when you're back online.");
    } finally {
      setTripBusy(false);
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Pressable accessibilityRole="button" accessibilityHint="Switch lists" onPress={() => router.push("/lists")} style={{ gap: 2, flexShrink: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Text style={styles.eyebrow}>{list?.private ? "Private list" : "Shared list"}</Text>
              {list?.private ? <Icon name="lock-closed" size={12} color={colors.muted} /> : null}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
                {list?.name ?? "Shopping"}
              </Text>
              <Icon name="chevron-down" size={22} color={colors.muted} />
            </View>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <IconButton icon="swap-vertical" label="Change aisle order" onPress={() => router.push("/aisles")} />
            <IconButton icon="storefront-outline" label="Shop online" onPress={() => router.push("/online")} />
            <IconButton icon="people-outline" label="Sharing and sync" onPress={() => router.push("/settings")} />
          </View>
        </View>

        {status === "unauthorized" ? (
          <View style={styles.alert}>
            <Text style={styles.alertText}>This device was signed out. Sign in again to keep syncing.</Text>
            <Pressable accessibilityRole="button" onPress={() => void useStore.getState().signOut()} hitSlop={8}>
              <Text style={styles.alertAction}>Sign in</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.statusRow}>
          <Pressable accessibilityRole="button" onPress={() => router.push("/settings")} style={styles.statusPress}>
            <View style={[styles.statusDot, { backgroundColor: ok ? colors.accent : "#C2571A" }]} />
            <Text style={styles.statusStrong}>{total ? `${left} of ${total} left` : "Empty list"}</Text>
            <Text style={styles.statusText} numberOfLines={1}>
              · {syncLabel(status, lastSyncAt, outbox)}
            </Text>
          </Pressable>
          {doneCount > 0 ? (
            <Pressable accessibilityRole="button" onPress={clearDone} hitSlop={8}>
              <Text style={styles.clear}>Clear ticked</Text>
            </Pressable>
          ) : null}
        </View>

        {myTrip ? (
          <View style={styles.tripOn}>
            <Icon name="cart" size={20} color="#FFFFFF" />
            <Text style={styles.tripOnText}>
              Shopping · {minutesSince(myTrip.startedAt)}
              {ticked ? ` · ${ticked} ticked` : ""}
            </Text>
            <Pressable accessibilityRole="button" onPress={finishTrip} disabled={tripBusy} style={styles.tripFinish}>
              {tripBusy ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.tripFinishText}>Finish</Text>}
            </Pressable>
          </View>
        ) : (
          <View style={{ flexDirection: "row", gap: 8 }}>
            {othersShopping.length ? (
              <View style={styles.tripOther}>
                <Icon name="cart-outline" size={18} color={colors.accentInk} />
                <Text style={styles.tripOtherText} numberOfLines={1}>
                  {othersShopping.map((t) => t.name).join(" & ")} {othersShopping.length > 1 ? "are" : "is"} shopping now
                </Text>
              </View>
            ) : null}
            <Pressable accessibilityRole="button" onPress={startTrip} disabled={tripBusy} style={[styles.tripStart, othersShopping.length ? null : { flex: 1 }]}>
              <Icon name="cart-outline" size={18} color={colors.ink} />
              <Text style={styles.tripStartText}>{othersShopping.length ? "Me too" : "Start shopping"}</Text>
            </Pressable>
          </View>
        )}

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
        {usual.some((u) => !onList.has(u.name.toLowerCase())) ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.usualTitle}>Usual items you might need</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {usual
                .filter((u) => !onList.has(u.name.toLowerCase()))
                .map((u) => (
                  <Pressable
                    key={u.name}
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${u.name}, last bought ${u.lastBoughtDaysAgo} days ago`}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      addItems([{ name: u.name, brand: u.brand, size: u.size, sectionId: u.sectionId }], "text");
                    }}
                    style={styles.usualChip}
                  >
                    <Icon name="add" size={16} color={colors.accent} />
                    <Text style={styles.usualName}>{u.name}</Text>
                    <Text style={styles.usualMeta}>{u.lastBoughtDaysAgo}d ago</Text>
                  </Pressable>
                ))}
            </ScrollView>
          </View>
        ) : null}

        {groups.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing on the list</Text>
            <Text style={styles.emptyText}>Scan a barcode, snap a photo, or type above.</Text>
          </View>
        ) : null}

        {groups.map(({ section, items: rows, left: groupLeft }) => {
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
                  {rows.map((item, i) => {
                    const mine = !item.addedById || item.addedById === user?.id;
                    return (
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
                          accessibilityLabel={mine ? "Added by you" : `Added by ${item.addedBy ?? "someone else"}`}
                          style={[styles.avatar, { backgroundColor: avatarColor(mine) }]}
                        >
                          <Text style={styles.avatarText}>{initial(item.addedBy ?? user?.name ?? null)}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
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
  titleRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 8 },
  eyebrow: { fontSize: 13, fontWeight: "600", color: colors.muted },
  title: { fontSize: 34, fontWeight: "800", letterSpacing: -0.6, color: colors.ink, flexShrink: 1 },
  alert: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.warnBg, borderColor: colors.warnLine, borderWidth: 1, borderRadius: radius.md, padding: 12 },
  alertText: { flex: 1, fontSize: 14, lineHeight: 19, color: colors.warnInk },
  alertAction: { fontSize: 14, fontWeight: "700", color: colors.warnInk },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  statusPress: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minHeight: 28 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusStrong: { fontSize: 14, fontWeight: "600", color: colors.ink },
  statusText: { fontSize: 14, color: colors.muted, flexShrink: 1 },
  clear: { fontSize: 14, fontWeight: "700", color: colors.accent },
  tripOn: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.accent, borderRadius: radius.md, paddingLeft: 14, paddingRight: 6, height: 52 },
  tripOnText: { flex: 1, color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  tripFinish: { height: 40, paddingHorizontal: 16, borderRadius: radius.sm, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", minWidth: 80 },
  tripFinishText: { color: colors.accent, fontSize: 15, fontWeight: "800" },
  tripOther: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.accentTint, borderRadius: radius.md, paddingHorizontal: 12, height: 44 },
  tripOtherText: { flex: 1, color: colors.accentInk, fontSize: 14, fontWeight: "600" },
  tripStart: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 44, paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  tripStartText: { fontSize: 15, fontWeight: "700", color: colors.ink },
  addRow: { flexDirection: "row", gap: 8 },
  addInput: { flex: 1, height: 48, borderRadius: 14, paddingHorizontal: 16 },
  addButton: { width: 48, height: 48, borderRadius: 14, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 14 },
  usualTitle: { fontSize: 13, fontWeight: "700", color: colors.muted, paddingHorizontal: 4 },
  usualChip: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  usualName: { fontSize: 14, fontWeight: "600", color: colors.ink },
  usualMeta: { fontSize: 13, color: colors.muted },
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
