import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Icon, IconButton, SectionChips, Stepper } from "../components/ui";
import { api, ApiError, type Product } from "../lib/api";
import { useStore } from "../lib/store";
import { colors, radius } from "../lib/theme";

type Phase =
  | { kind: "scanning" }
  | { kind: "looking"; code: string }
  | { kind: "found"; product: Product }
  | { kind: "notFound"; code: string }
  | { kind: "error"; code: string; message: string };

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ kind: "scanning" });
  const [qty, setQty] = useState(1);
  const [sectionId, setSectionId] = useState("other");
  const [torch, setTorch] = useState(false);
  const busy = useRef(false);
  const sections = useStore((st) => st.sections);

  async function lookup(code: string) {
    setPhase({ kind: "looking", code });
    try {
      const res = await api.barcode(useStore.getState().settings, code);
      if (res.found && res.product) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setSectionId(res.product.sectionId);
        setQty(1);
        setPhase({ kind: "found", product: res.product });
      } else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setPhase({ kind: "notFound", code });
      }
    } catch (err) {
      setPhase({ kind: "error", code, message: err instanceof ApiError ? err.message : "Lookup failed." });
    }
  }

  function onScanned({ data }: BarcodeScanningResult) {
    if (busy.current) return;
    busy.current = true;
    void lookup(data);
  }

  function reset() {
    busy.current = false;
    setPhase({ kind: "scanning" });
  }

  function add() {
    if (phase.kind !== "found") return;
    const p = phase.product;
    useStore.getState().addItems([{ name: p.name, brand: p.brand, size: p.size, qty, sectionId, barcode: p.barcode }], "scan");
    router.back();
  }

  if (!permission) return <View style={styles.root} />;

  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.centered, { padding: 24 }]}>
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permText}>To scan barcodes, allow Shopping to use the camera.</Text>
        <Button label="Allow camera" onPress={requestPermission} style={{ alignSelf: "stretch" }} />
        <Button label="Not now" variant="secondary" onPress={() => router.back()} style={{ alignSelf: "stretch" }} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e"] }}
        onBarcodeScanned={phase.kind === "scanning" ? onScanned : undefined}
      />

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <IconButton dark icon="close" label="Close scanner" onPress={() => router.back()} />
        <View style={styles.segment}>
          <View style={styles.segmentOn}>
            <Text style={styles.segmentOnText}>Barcode</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => router.replace("/photo")} style={styles.segmentOff}>
            <Text style={styles.segmentOffText}>Photo</Text>
          </Pressable>
        </View>
        <IconButton dark icon={torch ? "flash" : "flash-outline"} label={torch ? "Torch off" : "Torch on"} onPress={() => setTorch((t) => !t)} />
      </View>

      <View style={styles.viewfinder} pointerEvents="none">
        <View style={styles.reticle}>
          <View style={[styles.corner, { left: 0, top: 0, borderLeftWidth: 4, borderTopWidth: 4, borderTopLeftRadius: 14 }]} />
          <View style={[styles.corner, { right: 0, top: 0, borderRightWidth: 4, borderTopWidth: 4, borderTopRightRadius: 14 }]} />
          <View style={[styles.corner, { left: 0, bottom: 0, borderLeftWidth: 4, borderBottomWidth: 4, borderBottomLeftRadius: 14 }]} />
          <View style={[styles.corner, { right: 0, bottom: 0, borderRightWidth: 4, borderBottomWidth: 4, borderBottomRightRadius: 14 }]} />
          {phase.kind === "scanning" ? <View style={styles.scanLine} /> : null}
        </View>
        {phase.kind === "scanning" ? <Text style={styles.hint}>Point at a barcode</Text> : null}
      </View>

      {phase.kind !== "scanning" ? (
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
          <View style={styles.handle} />

          {phase.kind === "looking" ? (
            <View style={[styles.centered, { paddingVertical: 28, gap: 12 }]}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.muted}>Looking up {phase.code}…</Text>
            </View>
          ) : null}

          {phase.kind === "found" ? (
            <>
              <View style={styles.foundRow}>
                <Icon name="checkmark" size={16} color={colors.accent} />
                <Text style={styles.foundText}>Found it</Text>
              </View>
              <View style={{ gap: 2 }}>
                <Text style={styles.productName}>{phase.product.name}</Text>
                <Text style={styles.muted}>{[phase.product.brand, phase.product.size].filter(Boolean).join(" · ") || phase.product.barcode}</Text>
              </View>
              <SectionChips sections={sections} value={sectionId} onChange={setSectionId} />
              <View style={styles.qtyRow}>
                <Text style={styles.muted}>Quantity</Text>
                <Stepper value={qty} onChange={setQty} />
              </View>
              <View style={styles.actions}>
                <Button label="Scan another" variant="secondary" onPress={reset} style={{ flex: 1 }} />
                <Button label="Add to list" onPress={add} style={{ flex: 1 }} />
              </View>
            </>
          ) : null}

          {phase.kind === "notFound" ? (
            <>
              <Text style={styles.productName}>Not in the product database</Text>
              <Text style={styles.muted}>Take a photo and Claude will work out what it is. You can save it for next time.</Text>
              <Button
                label="Identify from a photo"
                icon="camera-outline"
                onPress={() => router.replace({ pathname: "/photo", params: { barcode: phase.code } })}
              />
              <Button label="Scan something else" variant="secondary" onPress={reset} />
            </>
          ) : null}

          {phase.kind === "error" ? (
            <>
              <Text style={styles.productName}>Couldn't look that up</Text>
              <Text style={styles.muted}>{phase.message} You can type the item on the list instead.</Text>
              <View style={styles.actions}>
                <Button label="Close" variant="secondary" onPress={() => router.back()} style={{ flex: 1 }} />
                <Button label="Try again" onPress={() => lookup(phase.code)} style={{ flex: 1 }} />
              </View>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.camera },
  centered: { alignItems: "center", justifyContent: "center", gap: 12 },
  permTitle: { fontSize: 22, fontWeight: "700", color: "#FFFFFF" },
  permText: { fontSize: 15, color: "rgba(255,255,255,0.8)", textAlign: "center", marginBottom: 8 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  segment: { flexDirection: "row", padding: 4, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.16)", gap: 2 },
  segmentOn: { height: 36, paddingHorizontal: 18, borderRadius: radius.pill, backgroundColor: "#FFFFFF", justifyContent: "center" },
  segmentOnText: { fontSize: 15, fontWeight: "700", color: colors.ink },
  segmentOff: { height: 36, paddingHorizontal: 18, borderRadius: radius.pill, justifyContent: "center" },
  segmentOffText: { fontSize: 15, fontWeight: "600", color: "#FFFFFF" },
  viewfinder: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18 },
  reticle: { width: 270, height: 150 },
  corner: { position: "absolute", width: 34, height: 34, borderColor: "#FFFFFF" },
  scanLine: { position: "absolute", left: 18, right: 18, top: 74, height: 2, borderRadius: 1, backgroundColor: colors.scanLine },
  hint: { fontSize: 15, color: "rgba(255,255,255,0.9)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 14,
  },
  handle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.field },
  foundRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  foundText: { fontSize: 13, fontWeight: "700", color: colors.accent },
  productName: { fontSize: 22, fontWeight: "800", color: colors.ink, letterSpacing: -0.3 },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  qtyRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  actions: { flexDirection: "row", gap: 10 },
});
