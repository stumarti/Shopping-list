import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { Section } from "../lib/ops";
import { colors, radius } from "../lib/theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];

export function Icon({ name, size = 22, color = colors.ink }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} />;
}

type Variant = "primary" | "secondary" | "dark" | "danger";

export function Button({
  label,
  icon,
  onPress,
  variant = "primary",
  disabled,
  style,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const bg = { primary: colors.accent, secondary: colors.chip, dark: colors.ink, danger: "#FBE9E7" }[variant];
  const fg = { primary: "#FFFFFF", secondary: colors.ink, dark: "#FFFFFF", danger: colors.danger }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }, style]}
    >
      {icon ? <Icon name={icon} color={fg} /> : null}
      <Text style={[s.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  dark,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  dark?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [dark ? s.iconButtonDark : s.iconButton, pressed && { opacity: 0.7 }]}
    >
      <Icon name={icon} color={dark ? "#FFFFFF" : colors.ink} size={dark ? 20 : 22} />
    </Pressable>
  );
}

export function SectionChips({
  sections,
  value,
  onChange,
}: {
  sections: Section[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
      {sections.map((sec) => {
        const on = sec.id === value;
        return (
          <Pressable
            key={sec.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(sec.id)}
            style={[s.chip, { borderColor: on ? colors.accent : colors.field, backgroundColor: on ? colors.accentTint : colors.surface }]}
          >
            <View style={[s.dot, { backgroundColor: sec.color }]} />
            <Text style={s.chipText}>{sec.name}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <View style={s.stepper}>
      <Pressable accessibilityRole="button" accessibilityLabel="Decrease quantity" onPress={() => onChange(Math.max(1, value - 1))} style={s.stepBtn}>
        <Icon name="remove" size={20} />
      </Pressable>
      <Text accessibilityLiveRegion="polite" style={s.stepValue}>
        {value}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Increase quantity" onPress={() => onChange(Math.min(99, value + 1))} style={s.stepBtn}>
        <Icon name="add" size={20} />
      </Pressable>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

export const s = StyleSheet.create({
  button: {
    height: 54,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 16, fontWeight: "700" },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonDark: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  chipText: { fontSize: 14, fontWeight: "600", color: colors.ink },
  dot: { width: 10, height: 10, borderRadius: 3 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 4 },
  stepBtn: { width: 44, height: 40, borderRadius: radius.sm, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center" },
  stepValue: { minWidth: 32, textAlign: "center", fontSize: 17, fontWeight: "700", color: colors.ink },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  label: { fontSize: 13, fontWeight: "600", color: colors.muted },
  input: {
    height: 46,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.field,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    fontSize: 16,
    color: colors.ink,
  },
});
