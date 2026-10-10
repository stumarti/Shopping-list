export const colors = {
  ground: "#F4F5F1",
  surface: "#FFFFFF",
  ink: "#1A1F1C",
  muted: "#5B635E",
  faint: "#8A918C",
  line: "#E2E5E0",
  lineSoft: "#ECEEEA",
  field: "#D6DBD4",
  chip: "#EAEEE8",
  accent: "#1E6B47",
  accentTint: "#E3EFE7",
  accentInk: "#17573A",
  doneText: "#6B726D",
  unchecked: "#B9C0B8",
  warnBg: "#FFF4E6",
  warnLine: "#F0D9BC",
  warnInk: "#5A3A12",
  danger: "#B42318",
  camera: "#0F1311",
  scanLine: "#5BD08F",
};

export const radius = { sm: 12, md: 16, lg: 18, xl: 20, pill: 999 };

/** Two-tone avatar colours: you vs anyone else on the list. */
export function avatarColor(mine: boolean): string {
  return mine ? "#DCE9E1" : "#F3E3D3";
}

export function initial(name: string | null): string {
  return (name?.trim()[0] ?? "?").toUpperCase();
}
