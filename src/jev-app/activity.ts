// Tool intent and permission are not evidence that an action completed.
export type ActivityKind = 'command' | 'fileChange' | 'tool';
export type ActivityStatus = 'requested' | 'allowed' | 'denied' | 'completed' | 'failed' | 'unknown';

export function formatActivity(kind: ActivityKind, detail: string, status: string): string {
  if (status === 'completed') return `${kind === 'command' ? 'ausgeführt' : kind === 'fileChange' ? 'geändert' : 'Werkzeug abgeschlossen'}: ${detail}`;
  const state = status === 'denied' || status === 'declined' ? 'abgelehnt'
    : status === 'failed' ? 'fehlgeschlagen'
    : status === 'allowed' ? 'genehmigt, Ergebnis ausstehend'
    : status === 'requested' || status === 'called' || status === 'inProgress' ? 'angefragt, Ergebnis ausstehend'
    : 'Ergebnis unbekannt';
  return `${state} (${kind === 'command' ? 'Befehl' : kind === 'fileChange' ? 'Dateiänderung' : 'Werkzeug'}): ${detail}`;
}

const short = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
export const toolKind = (name: string): ActivityKind => name === 'Bash' || name === 'PowerShell' ? 'command' : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) ? 'fileChange' : 'tool';

/** One final state per tool id for persistence; live listeners also see state transitions. */
export class ToolActivityLog {
  readonly lines: string[] = [];
  private tools = new Map<string, { kind: ActivityKind; detail: string; status: ActivityStatus; index: number }>();
  constructor(private emit?: (line: string) => void) {}
  request(id: string, name: string, input: Record<string, unknown>) {
    if (this.tools.has(id)) return;
    const kind = toolKind(name), detail = short(kind === 'command' ? input.command : kind === 'fileChange' ? input.file_path ?? input.notebook_path : name);
    this.tools.set(id, { kind, detail, status: 'requested', index: this.lines.length });
    this.update(id, 'requested');
  }
  update(id: string, status: ActivityStatus) {
    const tool = this.tools.get(id);
    // A denial is terminal; its subsequent error result must not become execution evidence.
    if (!tool || ['denied', 'completed', 'failed'].includes(tool.status)) return;
    tool.status = status;
    const line = formatActivity(tool.kind, tool.detail, status);
    this.lines[tool.index] = line; this.emit?.(line);
  }
}
