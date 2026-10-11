import * as DocumentPicker from "expo-document-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon } from "../../components/ui";
import { api, ApiError, ConflictError, type ReceiptSummary } from "../../lib/api";
import { useStore } from "../../lib/store";
import { colors, radius } from "../../lib/theme";

// Long edge 2000px keeps small receipt print readable while staying well under upload limits.
async function toJpeg(uri: string): Promise<string> {
  const img = await ImageManipulator.manipulate(uri).resize({ height: 2000 }).renderAsync();
  const saved = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  if (!saved.base64) throw new Error("Couldn't read the photo");
  return saved.base64;
}

const euro = (n: number | null) => (n == null ? "" : `€${n.toFixed(2)}`);
const when = (day: string | null) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "Date unknown");

export default function ReceiptsScreen() {
  const insets = useSafeAreaInsets();
  const listId = useStore((st) => st.currentListId);
  const [receipts, setReceipts] = useState<ReceiptSummary[] | null>(null);
  const [reading, setReading] = useState(false);
  const conn = () => useStore.getState().connection();

  useFocusEffect(
    useCallback(() => {
      api
        .receipts(conn(), listId)
        .then((r) => setReceipts(r.receipts))
        .catch(() => setReceipts([]));
    }, [listId]),
  );

  async function send(files: Array<{ data: string; mediaType: string }>) {
    setReading(true);
    try {
      const { receipt } = await api.readReceipt(conn(), listId, files);
      router.push({ pathname: "/receipts/[id]", params: { id: receipt.id } });
    } catch (err) {
      if (err instanceof ConflictError) Alert.alert("Already added", "That receipt is already in your history.");
      else Alert.alert("Couldn't read the receipt", err instanceof ApiError ? err.message : "Try a flatter, brighter photo.");
    } finally {
      setReading(false);
    }
  }

  async function takePhotos() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const shots: string[] = [];
    // A long receipt can take several photos: keep going until they say done.
    for (;;) {
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
      if (res.canceled) break;
      shots.push(await toJpeg(res.assets[0].uri));
      const more = await new Promise<boolean>((resolve) =>
        Alert.alert(`${shots.length} photo${shots.length === 1 ? "" : "s"}`, "Is there more of this receipt?", [
          { text: "That's all", onPress: () => resolve(false) },
          { text: "Take another", onPress: () => resolve(true) },
        ]),
      );
      if (!more) break;
    }
    if (shots.length) await send(shots.map((data) => ({ data, mediaType: "image/jpeg" })));
  }

  async function fromPhotos() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 10, quality: 0.9 });
    if (res.canceled) return;
    setReading(true);
    try {
      const files = await Promise.all(res.assets.map(async (a) => ({ data: await toJpeg(a.uri), mediaType: "image/jpeg" })));
      await send(files);
    } finally {
      setReading(false);
    }
  }

  async function fromPdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: "application/pdf", base64: true, copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]?.base64) return;
    await send([{ data: res.assets[0].base64, mediaType: "application/pdf" }]);
  }

  const waiting = receipts?.filter((r) => r.status === "review") ?? [];
  const done = receipts?.filter((r) => r.status === "confirmed") ?? [];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.ground }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 16 }}>
      <View style={{ gap: 8, paddingHorizontal: 4 }}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Icon name="chevron-back" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>
          Receipts
        </Text>
        <Text style={styles.sub}>Each receipt teaches the app what you buy and how often, so it can plan your week.</Text>
      </View>

      {reading ? (
        <Card style={{ padding: 16, gap: 10, alignItems: "center" }}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.cardTitle}>Reading your receipt…</Text>
          <Text style={[styles.small, { textAlign: "center" }]}>This takes about 10–30 seconds.</Text>
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          <Button label="Photograph a receipt" icon="camera-outline" onPress={takePhotos} />
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button label="From Photos" icon="images-outline" variant="secondary" onPress={fromPhotos} style={{ flex: 1 }} />
            <Button label="PDF / e-receipt" icon="document-outline" variant="secondary" onPress={fromPdf} style={{ flex: 1 }} />
          </View>
        </View>
      )}

      <View style={styles.tip}>
        <Icon name="folder-open-outline" color={colors.accentInk} size={18} />
        <Text style={styles.tipText}>
          Lots of old receipts? Copy them into the server's receipts folder (see the README) and they're read in the background.
        </Text>
      </View>

      {waiting.length ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.h2}>To check ({waiting.length})</Text>
          <Card>
            {waiting.map((r, i) => (
              <ReceiptRow key={r.id} r={r} first={i === 0} />
            ))}
          </Card>
        </View>
      ) : null}

      {!receipts ? <ActivityIndicator color={colors.accent} /> : null}
      {done.length ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.h2}>In your history ({done.length})</Text>
          <Card>
            {done.map((r, i) => (
              <ReceiptRow key={r.id} r={r} first={i === 0} />
            ))}
          </Card>
        </View>
      ) : null}
    </ScrollView>
  );
}

function ReceiptRow({ r, first }: { r: ReceiptSummary; first: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: "/receipts/[id]", params: { id: r.id } })}
      style={({ pressed }) => [styles.row, !first && styles.border, pressed && { backgroundColor: "#F7F8F5" }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowTitle}>
          {r.store ?? "Receipt"} · {when(r.purchasedOn)}
        </Text>
        <Text style={styles.small}>
          {r.items} item{r.items === 1 ? "" : "s"}
          {r.source === "inbox" ? " · imported" : ""}
        </Text>
      </View>
      <Text style={styles.total}>{euro(r.total)}</Text>
      <Icon name="chevron-forward" size={16} color={colors.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", height: 44, alignSelf: "flex-start", marginLeft: -6 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  sub: { fontSize: 15, lineHeight: 21, color: colors.muted },
  small: { fontSize: 13, lineHeight: 18, color: colors.muted },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.ink },
  h2: { marginHorizontal: 4, fontSize: 13, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase", color: colors.muted },
  tip: { flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: colors.accentTint, borderRadius: radius.md, padding: 12 },
  tipText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.accentInk },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  border: { borderTopWidth: 1, borderTopColor: colors.lineSoft },
  rowTitle: { fontSize: 16, fontWeight: "600", color: colors.ink },
  total: { fontSize: 16, fontWeight: "700", color: colors.ink },
});
