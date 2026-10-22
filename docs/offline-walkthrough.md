# MindRails Supervisor: Offline-Demo Schritt für Schritt

Die Demo zeigt zwei Entscheidungen aus dem echten Programmcode: **Sind alle vorgegebenen Kriterien markiert?** Und **wiederholen sich Arbeitsschritte ohne gemeldeten Fortschritt?** Sie nutzt synthetische Eingaben und benötigt keinen API-Schlüssel. Es werden keine Modelle aufgerufen, keine Agenten gestartet und keine Kundenprozesse verändert.

## 1. Installieren und starten

Voraussetzung: Node.js 24 oder neuer, npm und Git. Die Installation lädt Abhängigkeiten; die anschließende Demo läuft lokal.

```sh
git clone https://github.com/haskallalk-eng/mindrails-supervisor.git
cd mindrails-supervisor
npm ci --ignore-scripts
npm run build
npm run demo
```

Am **22. Oktober 2026** mit Node.js 24.19.0 ausgeführte Programmausgabe:

```text
SYNTHETIC MOCK DEMO — no API call, no semantic evaluation
3/5 markers → CONTINUE license, security
5/5 markers → FINISH
3 repeated steps → REVIEW
changed result → CONTINUE
```

| Eingabe | Entscheidung | Bedeutung in dieser Demo |
| --- | --- | --- |
| Drei von fünf Kriterien markiert | `CONTINUE` | Die Marker für `license` und `security` fehlen. |
| Alle fünf Kriterien markiert | `FINISH` | Der synthetische Prüfer erkennt alle verlangten Marker. |
| Drei identische Schritte ohne gemeldeten Fortschritt | `REVIEW` | Die Wiederholung erfüllt die Regel für eine Prüfung. |
| Der letzte Schritt liefert ein anderes Ergebnis | `CONTINUE` | Diese Wiederholungsregel greift nicht mehr. |

`FINISH` ist hier eine Empfehlung auf Basis künstlicher Marker. Das Programm hat damit weder Dateien gelesen noch Tests eines anderen Projekts ausgeführt. Auch ein geändertes Ergebnis ist noch kein Beweis für fachlichen Fortschritt.

## 2. Eine Eingabe und ihre Antwort ansehen

Öffne [examples/check.json](../examples/check.json). Die Datei enthält fünf Anforderungen, aber nur drei `[done:…]`-Marker. Der Mock-Modus gibt diese Unterschiede strukturiert zurück.

**macOS / Linux:**

```sh
MINDRAILS_PROVIDER=mock node dist/cli.js check examples/check.json
```

**Windows PowerShell:**

```powershell
$env:MINDRAILS_PROVIDER = 'mock'
node dist/cli.js check examples/check.json
```

Auszug der tatsächlich erhaltenen JSON-Antwort; weitere Felder sind hier ausgelassen:

```json
{
  "provider": "mock",
  "model": "synthetic-markers-v1",
  "synthetic": true,
  "requirementIds": ["license", "security"],
  "decision": "continue",
  "reasons": ["REQUIREMENTS_INCOMPLETE", "TASK_INCOMPLETE"]
}
```

In einer lokalen Kopie kannst du dem Feld `currentResult` die Marker `[done:license] [done:security]` hinzufügen und denselben Befehl erneut ausführen. Erwartet werden dann `decision: "finish"` und eine leere Liste fehlender Anforderungen. Die Datei bleibt ein synthetisches Beispiel; Marker ersetzen keine echten Nachweise.

## 3. Technisch nachvollziehen

| Frage | Einstieg im Code |
| --- | --- |
| Welche Eingaben erzeugt die Demo? | [CLI und Demo](../src/cli.ts) |
| Wie werden Anforderungen und Wiederholungen geprüft? | [Entscheidungslogik](../src/core.ts) |
| Was macht der synthetische Prüfer? | [MockProvider](../src/providers.ts) |
| Funktioniert die Verbindung zu einem MCP-Client? | [12 lokale Transport-Szenarien](../examples/mcp-e2e.mjs) |

```sh
npm run typecheck
npm test
npm run e2e
```

Der [Prüfnachweis](portfolio-validation.md) nennt Quellcode-Stand, Ergebnisse und Grenzen. Die Offline-Demo prüft Entscheidungsregeln; sie misst keine Modellgenauigkeit und belegt keine Zeit- oder Kostenersparnis. Für die optionale Anbindung an einen Modellanbieter gelten die separaten [Einrichtungs- und Datenhinweise](supervisor-reference.md).

[Projektübersicht](../README.md) · [Portfolio von Hassieb Kalla](https://github.com/haskallalk-eng)
