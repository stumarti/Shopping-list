import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, s as ui } from "../components/ui";
import { DEFAULT_SECTIONS } from "../lib/ops";
import { useStore } from "../lib/store";
import { colors, radius } from "../lib/theme";

export default function AislesScreen() {
  const insets = useSafeAreaInsets();
  const sections = useStore((st) => st.sections);
  const reorder = useStore((st) => st.reorderSections);

  function move(index: number, delta: number) {
    const order = sections.map((sec) => sec.id);
    const j = index + delta;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    reorder(order);
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.done}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          Aisle order
        </Text>
        <Text style={styles.sub}>Put sections in the order you walk the shop. Your list follows this order, for both of you.</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
        <View style={ui.card}>
          {sections.map((sec, i) => (
            <View key={sec.id} style={[styles.row, i > 0 && styles.rowBorder]}>
              <Text style={styles.num}>{i + 1}</Text>
              <View style={[ui.dot, { backgroundColor: sec.color }]} />
              <Text style={styles.name}>{sec.name}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Move ${sec.name} up`}
                accessibilityState={{ disabled: i === 0 }}
                disabled={i === 0}
                onPress={() => move(i, -1)}
                style={[styles.arrow, i === 0 && { opacity: 0.3 }]}
              >
                <Icon name="arrow-up" size={20} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Move ${sec.name} down`}
                accessibilityState={{ disabled: i === sections.length - 1 }}
                disabled={i === sections.length - 1}
                onPress={() => move(i, 1)}
                style={[styles.arrow, i === sections.length - 1 && { opacity: 0.3 }]}
              >
                <Icon name="arrow-down" size={20} />
              </Pressable>
            </View>
          ))}
        </View>
        <Pressable accessibilityRole="button" onPress={() => reorder(DEFAULT_SECTIONS.map((sec) => sec.id))} style={styles.reset}>
          <Text style={styles.resetText}>Reset to default order</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  header: { paddingHorizontal: 20, paddingBottom: 16, gap: 8 },
  done: { height: 40, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.ink, justifyContent: "center" },
  doneText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  sub: { fontSize: 15, lineHeight: 21, color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingLeft: 14, paddingRight: 6 },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.lineSoft },
  num: { width: 20, fontSize: 13, fontWeight: "700", color: colors.muted, textAlign: "right" },
  name: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.ink },
  arrow: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  reset: { alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  resetText: { fontSize: 14, fontWeight: "600", color: colors.accent },
});
