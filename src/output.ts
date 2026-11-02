/** Terminal output helpers. */

const BAR_WIDTH = 24;

/** Renders groups as aligned rows with a proportional bar. */
export function countLines(
  groups: { grupo: string | null; quantidade: number }[],
  total: number,
): string[] {
  const top = Math.max(1, ...groups.map((group) => group.quantidade));
  const labels = groups.map((group) => truncate(group.grupo ?? '(vazio)', 36));
  const counts = groups.map((group) => group.quantidade.toLocaleString('pt-BR'));
  const labelWidth = Math.max(0, ...labels.map((label) => label.length));
  const countWidth = Math.max(0, ...counts.map((count) => count.length));

  return groups.map((group, i) => {
    const bar = '█'.repeat(Math.max(1, Math.round((group.quantidade / top) * BAR_WIDTH)));
    const share =
      total > 0 ? `${((group.quantidade / total) * 100).toFixed(1).replace('.', ',')}%` : '';
    return `${labels[i]?.padEnd(labelWidth)}  ${counts[i]?.padStart(countWidth)}  ${bar.padEnd(BAR_WIDTH)}  ${share.padStart(6)}`;
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
