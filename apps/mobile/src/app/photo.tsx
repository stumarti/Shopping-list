import { CameraView, useCameraPermissions } from "expo-camera";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Image, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon, IconButton, Label, SectionChips, s as ui } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useStore } from "../lib/store";
import { colors, radius } from "../lib/theme";

type Phase = { kind: "camera" } | { kind: "thinking" } | { kind: "result"; confidence: "low" | "medium" | "high" } | { kind: "error"; message: string };

// ~1024px wide keeps labels readable while the upload stays well under a megabyte.
async function shrink(uri: string): Promise<string> {
  const rendered = await ImageManipulator.manipulate(uri).resize({ width: 1024 }).renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.7, base64: true });
  if (!saved.base64) throw new Error("Couldn't read the photo");
  return saved.base64;
}

export default function PhotoScreen() {
  const insets = useSafeAreaInsets();
  const { barcode } = useLocalSearchParams<{ barcode?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const sections = useStore((st) => st.sections);

  const [phase, setPhase] = useState<Phase>({ kind: "camera" });
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [size, setSize] = useState("");
  const [sectionId, setSectionId] = useState("other");
  const [remember, setRemember] = useState(true);

  async function capture() {
    if (!camera.current) return;
    try {
      const pic = await camera.current.takePictureAsync({ quality: 0.8 });
      setPhotoUri(pic.uri);
      setPhase({ kind: "thinking" });
      const image = await shrink(pic.uri);
      const result = await api.identify(useStore.getState().connection(), image);
      setName(result.name);
      setBrand(result.brand ?? "");
      setSize(result.size ?? "");
      setSectionId(result.sectionId);
      setPhase({ kind: "result", confidence: result.confidence });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof ApiError ? err.message : "Something went wrong taking the photo." });
    }
  }

  function retake() {
    setPhotoUri(null);
    setPhase({ kind: "camera" });
  }

  function add() {
    if (!name.trim()) return;
    const item = { name, brand: brand || null, size: size || null, sectionId, barcode: barcode ?? null };
    useStore.getState().addItems([item], "photo");
    if (barcode && remember) {
      // Best effort: if it fails, the photo route still works next time.
      api.rememberBarcode(useStore.getState().connection(), barcode, { name: name.trim(), brand: brand.trim() || null, size: size.trim() || null, sectionId }).catch(() => {});
    }
    router.back();
  }

  if (!permission) return <View style={styles.dark} />;

  if (!permission.granted) {
    return (
      <View style={[styles.dark, styles.centered, { padding: 24 }]}>
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permText}>To identify products from a photo, allow Shopping to use the camera.</Text>
        <Button label="Allow camera" onPress={requestPermission} style={{ alignSelf: "stretch" }} />
        <Button label="Not now" variant="secondary" onPress={() => router.back()} style={{ alignSelf: "stretch" }} />
      </View>
    );
  }

  if (phase.kind === "camera") {
    return (
      <View style={styles.dark}>
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <IconButton dark icon="close" label="Close" onPress={() => router.back()} />
          {barcode ? null : (
            <View style={styles.segment}>
              <Pressable accessibilityRole="button" onPress={() => router.replace("/scan")} style={styles.segmentOff}>
                <Text style={styles.segmentOffText}>Barcode</Text>
              </Pressable>
              <View style={styles.segmentOn}>
                <Text style={styles.segmentOnText}>Photo</Text>
              </View>
            </View>
          )}
          <View style={{ width: 44 }} />
        </View>
        <View style={{ flex: 1 }} />
        <View style={[styles.shutterBar, { paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.hint}>Fill the frame with the front of the pack</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Take photo" onPress={capture} style={styles.shutter}>
            <View style={styles.shutterInner} />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable accessibilityRole="button" onPress={retake} style={styles.back}>
          <Icon name="chevron-back" />
          <Text style={styles.backText}>Retake</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.headerTitle}>
          Identify item
        </Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.photo}>
          {photoUri ? <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
          <View style={styles.photoBadge}>
            <Text style={styles.photoBadgeText}>Checked by Claude via your home server</Text>
          </View>
        </View>

        {phase.kind === "thinking" ? (
          <View style={[styles.centered, { paddingVertical: 32 }]}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.muted}>Working out what this is…</Text>
          </View>
        ) : null}

        {phase.kind === "error" ? (
          <Card style={{ padding: 16, gap: 12 }}>
            <Text style={styles.errorTitle}>Couldn't identify it</Text>
            <Text style={styles.muted}>{phase.message}</Text>
            <Button label="Try again" onPress={retake} />
          </Card>
        ) : null}

        {phase.kind === "result" ? (
          <>
            {barcode ? (
              <View style={styles.banner}>
                <Text style={styles.bannerText}>That barcode isn't in the product database, so the item was identified from your photo instead.</Text>
                <View style={styles.switchRow}>
                  <Switch value={remember} onValueChange={setRemember} trackColor={{ true: colors.accent }} accessibilityLabel="Remember this barcode next time" />
                  <Text style={styles.bannerStrong}>Remember this barcode next time</Text>
                </View>
              </View>
            ) : null}

            <Card style={{ padding: 16, gap: 12 }}>
              <View style={{ gap: 6 }}>
                <Label>Item</Label>
                <TextInput accessibilityLabel="Item" value={name} onChangeText={setName} style={[ui.input, { fontWeight: "600" }]} />
              </View>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1, gap: 6 }}>
                  <Label>Brand</Label>
                  <TextInput accessibilityLabel="Brand" value={brand} onChangeText={setBrand} placeholder="Any" placeholderTextColor={colors.faint} style={ui.input} />
                </View>
                <View style={{ flex: 1, gap: 6 }}>
                  <Label>Size</Label>
                  <TextInput accessibilityLabel="Size" value={size} onChangeText={setSize} placeholder="Any" placeholderTextColor={colors.faint} style={ui.input} />
                </View>
              </View>
              <View style={{ gap: 8 }}>
                <Label>Aisle</Label>
                <SectionChips sections={sections} value={sectionId} onChange={setSectionId} />
              </View>
              <View style={styles.note}>
                <Icon name={phase.confidence === "low" ? "help-circle-outline" : "checkmark"} size={15} color={phase.confidence === "low" ? "#C2571A" : colors.accent} />
                <Text style={styles.noteText}>
                  {phase.confidence === "low" ? "Not sure about this one, so check the details." : "Read from the pack. Edit anything that's off."}
                </Text>
              </View>
            </Card>
          </>
        ) : null}
      </ScrollView>

      {phase.kind === "result" ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
          <Button label="Retake" variant="secondary" onPress={retake} style={{ flex: 1 }} />
          <Button label="Add to list" onPress={add} disabled={!name.trim()} style={{ flex: 2 }} />
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  dark: { flex: 1, backgroundColor: colors.camera },
  centered: { alignItems: "center", justifyContent: "center", gap: 12 },
  permTitle: { fontSize: 22, fontWeight: "700", color: "#FFFFFF" },
  permText: { fontSize: 15, color: "rgba(255,255,255,0.8)", textAlign: "center", marginBottom: 8 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  segment: { flexDirection: "row", padding: 4, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.16)", gap: 2 },
  segmentOn: { height: 36, paddingHorizontal: 18, borderRadius: radius.pill, backgroundColor: "#FFFFFF", justifyContent: "center" },
  segmentOnText: { fontSize: 15, fontWeight: "700", color: colors.ink },
  segmentOff: { height: 36, paddingHorizontal: 18, borderRadius: radius.pill, justifyContent: "center" },
  segmentOffText: { fontSize: 15, fontWeight: "600", color: "#FFFFFF" },
  shutterBar: { alignItems: "center", gap: 18 },
  hint: { fontSize: 15, color: "rgba(255,255,255,0.9)" },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: "#FFFFFF" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingBottom: 12 },
  back: { flexDirection: "row", alignItems: "center", height: 44, width: 80, gap: 2 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  headerTitle: { fontSize: 18, fontWeight: "700", color: colors.ink },
  body: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  photo: { height: 200, borderRadius: radius.xl, backgroundColor: "#D9DED7", overflow: "hidden" },
  photoBadge: {
    position: "absolute",
    left: 10,
    bottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: "rgba(15,19,17,0.78)",
  },
  photoBadgeText: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  errorTitle: { fontSize: 18, fontWeight: "700", color: colors.ink },
  banner: { backgroundColor: colors.warnBg, borderColor: colors.warnLine, borderWidth: 1, borderRadius: radius.md, padding: 14, gap: 10 },
  bannerText: { fontSize: 14, lineHeight: 20, color: colors.warnInk },
  bannerStrong: { fontSize: 14, fontWeight: "600", color: colors.warnInk, flex: 1 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  note: { flexDirection: "row", alignItems: "center", gap: 6 },
  noteText: { fontSize: 13, color: colors.muted, flex: 1 },
  footer: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
});
