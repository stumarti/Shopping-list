import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon, Label, s as ui } from "../../components/ui";
import { api, ApiError, ConflictError, type Receipt, type ReceiptLine } from "../../lib/api";
import { useStore } from "../../lib/store";
import { colors } from "../../lib/theme";

const euro = (n: number | null) => (n == null ? "–" : `€${n.toFixed(2)}`);

/** Check what was read from a receipt, fix anything wrong, then add it to your history. */
export default function ReceiptScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [store, setStore] = useState("");
  const [date, setDate] = useState("");
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conn = () => useStore.getState().connection();

  useEffect(() => {
    api
      .receipt(conn(), id)
      .then(({ receipt: r }) => {
        setReceipt(r);
        setStore(r.store ?? "");
        setDate(r.purchasedOn ?? "");
        setLines(r.lines);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load the receipt."));
  }, [id]);

  const editable = receipt?.status === "review";
  const products = lines.filter((l) => l.isProduct);
  const setLine = (i: number, patch: Partial<ReceiptLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function confirm() {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      Alert.alert("Check the date", "Use the format 2026-10-11.");
      return;
    }
    setBusy(true);
    try {
      await api.updateReceipt(conn(), id, { store: store.trim() || null, date: date || null, total: receipt?.total ?? null, lines });
      await api.confirmReceipt(conn(), id);
      router.back();
    } catch (err) {
      if (err instanceof ConflictError) Alert.alert("Already added", "That receipt is already in your history.");
      else Alert.alert("Couldn't save", err instanceof ApiError ? err.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    Alert.alert("Delete this receipt?", receipt?.status === "confirmed" ? "Its items are removed from your history too." : undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await api.deleteReceipt(conn(), id).catch(() => {});
          router.back();
        },
      },
    ]);
  }

  if (!receipt) {
    return <View style={[styles.center, { paddingTop: insets.top + 60 }]}>{error ? <Text style={styles.sub}>{error}</Text> : <ActivityIndicator color={colors.accent} />}</View>;
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.ground }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 24, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8, paddingHorizontal: 4 }}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
            <Icon name="chevron-back" />
            <Text style={styles.backText}>Receipts</Text>
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>
            {editable ? "Check receipt" : (receipt.store ?? "Receipt")}
          </Text>
          <Text style={styles.sub}>
            {editable
              ? "Untick anything that isn't a product, fix names that look wrong, then add it to your history."
              : `${products.length} items · ${euro(receipt.total)}`}
          </Text>
        </View>

        {editable ? (
          <Card style={{ padding: 16, gap: 12 }}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Label>Shop</Label>
                <TextInput accessibilityLabel="Shop" value={store} onChangeText={setStore} style={ui.input} />
              </View>
              <View style={{ flex: 1, gap: 6 }}>
                <Label>Date</Label>
                <TextInput accessibilityLabel="Date" value={date} onChangeText={setDate} placeholder="2026-10-11" placeholderTextColor={colors.faint} style={ui.input} />
              </View>
            </View>
            <Text style={styles.small}>Total {euro(receipt.total)}</Text>
          </Card>
        ) : null}

        <Card>
          {lines.map((l, i) => (
            <View key={i} style={[styles.line, i > 0 && styles.border, !l.isProduct && { opacity: 0.55 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                {editable && l.isProduct ? (
                  <TextInput accessibilityLabel={`Name for ${l.raw}`} value={l.name} onChangeText={(name) => setLine(i, { name })} style={styles.nameInput} />
                ) : (
                  <Text style={styles.name}>{l.isProduct ? l.name : l.raw}</Text>
                )}
                <Text style={styles.small}>
                  {l.raw}
                  {l.qty > 1 ? ` · ×${l.qty}` : ""}
                </Text>
              </View>
              <Text style={styles.price}>{euro(l.lineTotal)}</Text>
              {editable ? (
                <Switch value={l.isProduct} onValueChange={(isProduct) => setLine(i, { isProduct })} trackColor={{ true: colors.accent }} accessibilityLabel={`Count ${l.raw} as a product`} />
              ) : null}
            </View>
          ))}
        </Card>

        <Pressable accessibilityRole="button" onPress={remove} style={styles.delete}>
          <Text style={styles.deleteText}>Delete receipt</Text>
        </Pressable>
      </ScrollView>

      {editable ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
          <Button label={busy ? "Saving…" : `Add ${products.length} items to history`} onPress={confirm} disabled={busy || !products.length} />
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", backgroundColor: colors.ground },
  back: { flexDirection: "row", alignItems: "center", height: 44, alignSelf: "flex-start", marginLeft: -6 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  sub: { fontSize: 15, lineHeight: 21, color: colors.muted },
  small: { fontSize: 12, lineHeight: 17, color: colors.muted },
  line: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, minHeight: 56 },
  border: { borderTopWidth: 1, borderTopColor: colors.lineSoft },
  name: { fontSize: 15, fontWeight: "600", color: colors.ink },
  nameInput: { fontSize: 15, fontWeight: "600", color: colors.ink, paddingVertical: 2, borderBottomWidth: 1, borderBottomColor: colors.lineSoft },
  price: { fontSize: 14, fontWeight: "700", color: colors.ink, minWidth: 56, textAlign: "right" },
  delete: { alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  deleteText: { fontSize: 14, fontWeight: "700", color: colors.danger },
  footer: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.line },
});
