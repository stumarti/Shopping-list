import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Icon } from "../components/ui";
import { api, ApiError, type SeasonalItem, type Trends } from "../lib/api";
import { useStore } from "../lib/store";
import { colors, radius } from "../lib/theme";

// Chart colours: one validated green for single-series marks, and a light→dark ramp of the same hue
// for "how much more than usual" in the month strips. Text always uses ink colours, never the mark colour.
const MARK = "#1A7F4B";
const RAMP = ["#ECEEEA", "#D3EADC", "#9FD0B2", "#5CAA7F", MARK];
const rampFor = (index: number) => (index <= 0 ? RAMP[0] : index < 0.8 ? RAMP[1] : index < 1.3 ? RAMP[2] : index < 2 ? RAMP[3] : RAMP[4]);
const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const euro = (n: number) => `€${n.toFixed(n >= 100 ? 0 : 2)}`;
const isCurrent = (ym: string) => ym === new Date().toISOString().slice(0, 7);
const monthLabel = (ym: string) => `${MONTH_SHORT[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export default function TrendsScreen() {
  const insets = useSafeAreaInsets();
  const listId = useStore((st) => st.currentListId);
  const [data, setData] = useState<Trends | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      api
        .trends(useStore.getState().connection(), listId)
        .then(setData)
        .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load trends."));
    }, [listId]),
  );

  const thisMonth = new Date().getMonth();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.ground }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 18 }}>
      <View style={{ gap: 8, paddingHorizontal: 4 }}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Icon name="chevron-back" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>
          Trends
        </Text>
        {data?.historyFrom ? <Text style={styles.sub}>From your receipts and ticked items since {new Date(`${data.historyFrom}T12:00:00Z`).toLocaleDateString([], { month: "long", year: "numeric" })}.</Text> : null}
      </View>

      {error ? <Text style={[styles.sub, { color: colors.danger }]}>{error}</Text> : null}
      {!data && !error ? <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} /> : null}

      {data ? (
        <>
          <SpendChart spend={data.spend.slice(-12)} />

          {data.inSeasonNow.length ? (
            <Card style={{ padding: 16, gap: 12 }}>
              <Text style={styles.cardTitle}>In season for you now</Text>
              <Text style={styles.small}>Things you buy much more often around {MONTH_SHORT[thisMonth]}.</Text>
              {data.inSeasonNow.map((s) => (
                <SeasonRow key={s.key} item={s} highlight={thisMonth} />
              ))}
            </Card>
          ) : null}

          <Card style={{ padding: 16, gap: 12 }}>
            <Text style={styles.cardTitle}>Seasonal favourites</Text>
            {data.hasSeasons ? (
              data.seasonal.length ? (
                <>
                  <Text style={styles.small}>Darker months are when you buy it most. Tap a month for details.</Text>
                  {data.seasonal.map((s) => (
                    <SeasonRow key={s.key} item={s} highlight={thisMonth} />
                  ))}
                  <Legend />
                </>
              ) : (
                <Text style={styles.small}>Nothing strongly seasonal yet: you buy most things all year round.</Text>
              )
            ) : (
              <Text style={styles.small}>Seasons show up once there's about a year of history. Importing old receipts gets you there straight away.</Text>
            )}
          </Card>

          {data.top.length ? <TopItems top={data.top} /> : null}
        </>
      ) : null}
    </ScrollView>
  );
}

/** Monthly spend from receipts: one series, columns from a shared baseline, tap a month for its value. */
function SpendChart({ spend }: { spend: Trends["spend"] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(...spend.map((m) => m.total), 0);
  const latest = spend.length - 1;
  const peak = spend.findIndex((m) => m.total === max);
  const H = 140;

  return (
    <Card style={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={[styles.cardTitle, { flex: 1 }]}>Spend per month</Text>
        <Pressable accessibilityRole="button" onPress={() => setAsTable(!asTable)} hitSlop={8}>
          <Text style={styles.toggle}>{asTable ? "Show chart" : "Show table"}</Text>
        </Pressable>
      </View>
      {max === 0 ? (
        <Text style={styles.small}>Add receipts to see what you spend each month.</Text>
      ) : asTable ? (
        <View>
          {[...spend].reverse().map((m) => (
            <View key={m.month} style={styles.tableRow}>
              <Text style={styles.tableKey}>{monthLabel(m.month)}</Text>
              <Text style={styles.small}>{m.receipts ? `${m.receipts} receipt${m.receipts === 1 ? "" : "s"}` : ""}</Text>
              <Text style={styles.tableVal}>{m.receipts ? euro(m.total) : "–"}</Text>
            </View>
          ))}
        </View>
      ) : (
        <>
          <Text style={styles.readout} accessibilityLiveRegion="polite">
            {selected !== null
              ? `${monthLabel(spend[selected].month)}: ${spend[selected].receipts ? euro(spend[selected].total) : "no receipts"}${isCurrent(spend[selected].month) ? " so far" : ""}`
              : `Highest: ${monthLabel(spend[peak].month)}, ${euro(max)}`}
          </Text>
          <View style={{ height: H, flexDirection: "row", alignItems: "flex-end", borderBottomWidth: 1, borderBottomColor: colors.line }}>
            {spend.map((m, i) => {
              const h = max ? Math.max(m.total > 0 ? 3 : 0, (m.total / max) * (H - 18)) : 0;
              const dim = selected !== null && selected !== i;
              return (
                // Tap target is the whole column slot, wider and taller than the bar itself.
                <Pressable
                  key={m.month}
                  accessibilityRole="button"
                  accessibilityLabel={`${monthLabel(m.month)}, ${m.receipts ? euro(m.total) : "no receipts"}`}
                  onPress={() => setSelected(selected === i ? null : i)}
                  style={{ flex: 1, height: H, alignItems: "center", justifyContent: "flex-end" }}
                >
                  {(i === peak || i === latest) && selected === null && m.total > 0 ? (
                    <Text style={styles.barLabel}>
                      {euro(m.total)}
                      {i === latest && i !== peak && isCurrent(m.month) ? "\nso far" : ""}
                    </Text>
                  ) : null}
                  <View style={{ width: "62%", maxWidth: 24, height: h, backgroundColor: MARK, opacity: dim ? 0.35 : 1, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: "row" }}>
            {spend.map((m) => (
              <Text key={m.month} style={styles.axis}>
                {MONTH_INITIALS[Number(m.month.slice(5, 7)) - 1]}
              </Text>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

/** One product's year as 12 cells, shaded by how much more than usual you buy it that month. */
function SeasonRow({ item, highlight }: { item: SeasonalItem; highlight: number }) {
  const [tapped, setTapped] = useState<number | null>(null);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={[styles.itemName, { flex: 1 }]}>{item.name}</Text>
        <Text style={styles.small}>{tapped !== null ? `${MONTH_SHORT[tapped]}: ${item.index[tapped] ? `${item.index[tapped]}× your usual` : "never"}` : item.peakLabel}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 2 }}>
        {item.index.map((v, m) => (
          <Pressable
            key={m}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${MONTH_SHORT[m]}: ${v ? `${v} times your usual` : "never bought"}`}
            onPress={() => setTapped(tapped === m ? null : m)}
            style={[styles.cell, { backgroundColor: rampFor(v) }, m === highlight && styles.cellNow, tapped === m && styles.cellTapped]}
          >
            <Text style={[styles.cellText, { color: v >= 2 ? "#FFFFFF" : colors.ink }]}>{MONTH_INITIALS[m]}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Legend() {
  const steps = [
    { c: RAMP[0], t: "Never" },
    { c: RAMP[2], t: "Usual" },
    { c: RAMP[4], t: "2× or more" },
  ];
  return (
    <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
      {steps.map((s) => (
        <View key={s.t} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: s.c }} />
          <Text style={styles.small}>{s.t}</Text>
        </View>
      ))}
    </View>
  );
}

/** Most-bought items, last 90 days: horizontal bars with the count at the tip. */
function TopItems({ top }: { top: Trends["top"] }) {
  const max = Math.max(...top.map((t) => t.times));
  return (
    <Card style={{ padding: 16, gap: 10 }}>
      <Text style={styles.cardTitle}>What you buy most</Text>
      <Text style={styles.small}>Times bought in the last 90 days.</Text>
      {top.map((t) => (
        <View key={t.name} accessibilityLabel={`${t.name}, ${t.times} times`} style={{ gap: 4 }}>
          <Text style={styles.itemName}>{t.name}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ width: `${Math.max(4, (t.times / max) * 80)}%`, height: 14, backgroundColor: MARK, borderTopRightRadius: 4, borderBottomRightRadius: 4 }} />
            <Text style={styles.count}>{t.times}</Text>
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", height: 44, alignSelf: "flex-start", marginLeft: -6 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  sub: { fontSize: 15, lineHeight: 21, color: colors.muted },
  small: { fontSize: 13, lineHeight: 18, color: colors.muted },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.ink },
  toggle: { fontSize: 14, fontWeight: "700", color: colors.accent },
  readout: { fontSize: 15, fontWeight: "700", color: colors.ink },
  barLabel: { fontSize: 10, fontWeight: "700", color: colors.ink, marginBottom: 2, textAlign: "center" },
  axis: { flex: 1, textAlign: "center", fontSize: 11, color: colors.muted },
  tableRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36, borderBottomWidth: 1, borderBottomColor: colors.lineSoft },
  tableKey: { flex: 1, fontSize: 14, color: colors.ink },
  tableVal: { fontSize: 14, fontWeight: "700", color: colors.ink, minWidth: 64, textAlign: "right" },
  itemName: { fontSize: 15, fontWeight: "600", color: colors.ink },
  cell: { flex: 1, height: 30, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  cellNow: { borderWidth: 2, borderColor: colors.ink },
  cellTapped: { transform: [{ scale: 1.08 }] },
  cellText: { fontSize: 11, fontWeight: "700" },
  count: { fontSize: 13, fontWeight: "700", color: colors.ink },
});
