import { router } from "expo-router";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon, Label, s as ui } from "../components/ui";
import { HOUSEHOLD_LIST } from "../lib/ops";
import { useStore } from "../lib/store";
import { colors } from "../lib/theme";

export default function ListsScreen() {
  const insets = useSafeAreaInsets();
  const lists = useStore((st) => st.lists);
  const items = useStore((st) => st.items);
  const current = useStore((st) => st.currentListId);
  const me = useStore((st) => st.user?.id);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  function pick(id: string) {
    useStore.getState().setCurrentList(id);
    router.back();
  }

  function create() {
    if (!name.trim()) return;
    useStore.getState().createList(name, isPrivate);
    router.back();
  }

  function manage(id: string, listName: string) {
    Alert.prompt?.(
      "Rename list",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete list",
          style: "destructive",
          onPress: () =>
            Alert.alert(`Delete "${listName}"?`, "Its items are deleted too.", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => useStore.getState().deleteList(id) },
            ]),
        },
        { text: "Save", onPress: (value?: string) => value?.trim() && useStore.getState().renameList(id, value) },
      ],
      "plain-text",
      listName,
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.ground }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 16 }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          Lists
        </Text>

        <Card>
          {lists.map((l, i) => {
            const left = items.filter((it) => it.listId === l.id && !it.done).length;
            const canManage = l.id !== HOUSEHOLD_LIST && (l.private || l.ownerId === me);
            return (
              <View key={l.id} style={[styles.row, i > 0 && styles.border]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: l.id === current }}
                  onPress={() => pick(l.id)}
                  style={styles.rowMain}
                >
                  <Icon name={l.private ? "lock-closed-outline" : "people-outline"} size={20} color={colors.muted} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{l.name}</Text>
                    <Text style={styles.meta}>
                      {l.private ? "Only you" : "Everyone"} · {left} left
                    </Text>
                  </View>
                  {l.id === current ? <Icon name="checkmark" color={colors.accent} /> : null}
                </Pressable>
                {canManage ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Rename or delete ${l.name}`} onPress={() => manage(l.id, l.name)} style={styles.more}>
                    <Icon name="ellipsis-horizontal" size={20} color={colors.muted} />
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </Card>

        <Pressable accessibilityRole="button" onPress={() => router.push("/history")} style={styles.historyLink}>
          <Icon name="time-outline" size={20} color={colors.accent} />
          <Text style={styles.historyText}>Past trips for this list</Text>
        </Pressable>

        <Card style={{ padding: 16, gap: 12 }}>
          <Text style={styles.h2}>New list</Text>
          <View style={{ gap: 6 }}>
            <Label>Name</Label>
            <TextInput accessibilityLabel="New list name" value={name} onChangeText={setName} placeholder="e.g. Gifts, Party, Pharmacy" placeholderTextColor={colors.faint} style={ui.input} />
          </View>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>Private</Text>
              <Text style={styles.meta}>{isPrivate ? "Only you can see this list" : "Everyone on the server can see it"}</Text>
            </View>
            <Switch value={isPrivate} onValueChange={setIsPrivate} trackColor={{ true: colors.accent }} accessibilityLabel="Private list" />
          </View>
          <Button label="Create list" onPress={create} disabled={!name.trim()} />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.4, color: colors.ink },
  h2: { fontSize: 17, fontWeight: "700", color: colors.ink },
  row: { flexDirection: "row", alignItems: "center" },
  rowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  border: { borderTopWidth: 1, borderTopColor: colors.lineSoft },
  more: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  name: { fontSize: 16, fontWeight: "600", color: colors.ink },
  meta: { fontSize: 13, color: colors.muted },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  historyLink: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 4 },
  historyText: { fontSize: 15, fontWeight: "700", color: colors.accent },
});
