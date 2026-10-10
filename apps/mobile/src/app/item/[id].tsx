import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Label, SectionChips, Stepper, s as ui } from "../../components/ui";
import { useStore } from "../../lib/store";
import { colors } from "../../lib/theme";

export default function EditItemScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useStore((st) => st.items.find((i) => i.id === id));
  const sections = useStore((st) => st.sections);

  const [name, setName] = useState(item?.name ?? "");
  const [brand, setBrand] = useState(item?.brand ?? "");
  const [size, setSize] = useState(item?.size ?? "");
  const [qty, setQty] = useState(item?.qty ?? 1);
  const [sectionId, setSectionId] = useState(item?.sectionId ?? "other");

  if (!item) {
    return (
      <View style={[styles.root, { padding: 24, gap: 12 }]}>
        <Text style={styles.title}>This item was removed</Text>
        <Button label="Back to list" onPress={() => router.back()} />
      </View>
    );
  }

  function save() {
    if (!name.trim()) return;
    useStore.getState().updateItem(item!.id, { name: name.trim(), brand: brand.trim() || null, size: size.trim() || null, qty, sectionId });
    router.back();
  }

  function remove() {
    useStore.getState().removeItem(item!.id);
    router.back();
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 16 }} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>
        Edit item
      </Text>
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
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Label>Quantity</Label>
        <Stepper value={qty} onChange={setQty} />
      </View>
      <View style={{ gap: 8 }}>
        <Label>Aisle</Label>
        <SectionChips sections={sections} value={sectionId} onChange={setSectionId} />
      </View>
      <Button label="Save" onPress={save} disabled={!name.trim()} />
      <Button label="Delete item" icon="trash-outline" variant="danger" onPress={remove} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.4, color: colors.ink },
});
