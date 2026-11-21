/**
 * Mod del plugin: banda encima del prompt con el modo de Landinem de la sesión, el comando `/landinem`, un reloj que
 * refresca el estado y, en remoto, la declaración del monitor como última sección del prompt de sistema. No lee
 * ficheros ni habla con la red: cada cambio o lectura lanza `landinem-companion remote on|off|status --session <id>`,
 * que encuentra la sesión por el puntero que deja el hook SessionStart.
 */

import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { LandinemStatus } from "../types";

type Action = "on" | "off" | "status";

const status = atom({ plugin: "landinem", key: "status" } as const, null);

const UNAVAILABLE: LandinemStatus = { mode: "local", connected: false, title: null, reason: "unavailable" };

/** Los textos del mod en los dos idiomas; el de la sesión lo trae el estado (`locale`). */
const TEXTS = {
  es: {
    usage: "Uso: /landinem [on|off|estado]",
    argumentHint: "[on|off|estado]",
    description: "Activa o desactiva el modo remoto de Landinem en esta sesión",
    noMcp: "sin conectar: abre /mcp y autentica plugin:landinem:landinem. Si no sale en la lista, quita o desactiva el otro MCP landinem y reinicia Claude Code",
    signIn: "Landinem: falta conectar la cuenta. Abre /mcp, elige landinem y pulsa Authenticate.",
    revoked: "Landinem: este dispositivo está revocado. Abre /mcp, elige plugin:landinem:landinem y pulsa Authenticate para conectarlo de nuevo.",
    failed: "Landinem: no se pudo cambiar el modo. Inténtalo de nuevo en unos segundos.",
    local: "Landinem: sesión en local. Las tools siguen disponibles y no sale en Chats.",
    waiting: (n: number) => (n === 1 ? "1 mensaje espera para llegar al chat y se envía solo" : `${n} mensajes esperan para llegar al chat y se envían solos`),
    unreachable: (waiting: string) => `Landinem: sesión en remoto, pero Landinem no contesta: ${waiting} cuando vuelva.`,
    remote: "Landinem: sesión en remoto. Sale en Chats y recibe mensajes de la web.",
    bandRevoked: "dispositivo revocado: abre /mcp y pulsa Authenticate",
    bandSignIn: "sin conectar: abre /mcp y pulsa Authenticate",
    bandLocal: " local",
    bandOffline: (n: number) => ` remoto, sin conexión (${n} sin enviar)`,
    bandRemote: " remoto",
    bandConnecting: " remoto, conectando",
    toLocal: "Pasar a local",
    toRemote: "Activar remoto",
  },
  en: {
    usage: "Usage: /landinem [on|off|status]",
    argumentHint: "[on|off|status]",
    description: "Turn Landinem remote mode on or off for this session",
    noMcp: "not connected: open /mcp and authenticate plugin:landinem:landinem. If it is not listed, remove or disable the other landinem MCP and restart Claude Code",
    signIn: "Landinem: your account is not connected yet. Open /mcp, choose landinem and press Authenticate.",
    revoked: "Landinem: this device has been revoked. Open /mcp, choose plugin:landinem:landinem and press Authenticate to connect it again.",
    failed: "Landinem: the mode could not be changed. Try again in a few seconds.",
    local: "Landinem: local session. The tools are still available and it does not show up in Chats.",
    waiting: (n: number) => (n === 1 ? "1 message is waiting to reach the chat and will be sent on its own" : `${n} messages are waiting to reach the chat and will be sent on their own`),
    unreachable: (waiting: string) => `Landinem: remote session, but Landinem is not responding: ${waiting} when it is back.`,
    remote: "Landinem: remote session. It shows up in Chats and receives messages from the web.",
    bandRevoked: "device revoked: open /mcp and press Authenticate",
    bandSignIn: "not connected: open /mcp and press Authenticate",
    bandLocal: " local",
    bandOffline: (n: number) => ` remote, offline (${n} not sent)`,
    bandRemote: " remote",
    bandConnecting: " remote, connecting",
    toLocal: "Switch to local",
    toRemote: "Go remote",
  },
} as const;

/** Sin idioma (un acompañante anterior o sin estado aún), español, como antes. */
const textsOf = (s: LandinemStatus | null) => TEXTS[s?.locale ?? "es"];
/** Los motivos que un refresco no borra: falta algo que la persona tiene que hacer. */
const blocked = (s: LandinemStatus | null): boolean => s?.reason === "sign_in" || s?.reason === "no_mcp";

/** La última línea de stdout del acompañante, si es un estado. */
function parse(stdout: string): LandinemStatus | null {
  try {
    const value = JSON.parse(stdout.trim().split("\n").pop() ?? "") as LandinemStatus | null;
    return value?.mode === "local" || value?.mode === "remote" ? value : null;
  } catch {
    return null;
  }
}

/**
 * La respuesta de `/landinem`; también la lee el modelo, así que sin datos de más. Al pasar a remoto (`switched`) lleva
 * la declaración del monitor: el prompt de sistema solo cambia en un hilo nuevo o tras compactar, y esta línea llega ya.
 */
function textOf(s: LandinemStatus, switched: boolean): string {
  const t = textsOf(s);
  if (s.reason === "sign_in") return t.signIn;
  if (s.reason === "no_mcp") return `Landinem: ${t.noMcp}.`;
  if (s.reason === "revoked") return t.revoked;
  if (s.reason) return t.failed;
  if (s.mode === "local") return t.local;
  if (s.pending) return t.unreachable(t.waiting(s.pending));
  const line = t.remote;
  return switched && typeof s.declaration === "string" ? `${line}\n\n${s.declaration}` : line;
}

// Se pierde al recargar el módulo (y con él el reloj): lo vuelve a armar el primer hook que llegue.
let timer: { cancel: () => void } | undefined;

/**
 * Lo que queda guardado tras una respuesta (`got`, `null` si el acompañante falló):
 * - un fallo conserva el último modo y solo pone `reason: "unavailable"`; sin estado previo, local;
 * - un refresco (`status` del arranque o del reloj) que no llega a remoto no borra un `sign_in` ni un `no_mcp`: lo borran pasar a
 *   remoto o el resultado de una acción explícita (comando o botón).
 */
function merge(prev: LandinemStatus | null, got: LandinemStatus | null, refresh: boolean): LandinemStatus {
  if (refresh && prev && blocked(prev) && got?.mode !== "remote" && !blocked(got)) return prev;
  if (got) return got;
  return prev ? { ...prev, reason: "unavailable" } : UNAVAILABLE;
}

async function companion($: EngineInterface, action: Action, refresh = false): Promise<LandinemStatus> {
  let got: LandinemStatus | null = null;
  try {
    const run = await $.process.run(["node", `${$.plugin.root}/dist/landinem-companion.mjs`, "remote", action, "--session", await $.session.id()]);
    got = run.exitCode === 0 ? parse(run.stdout) : null;
  } catch {
    // No arranca o pasa del tiempo: queda `unavailable`.
  }
  let shown = UNAVAILABLE;
  await update($, status, (prev) => (shown = merge(prev, got, refresh)));
  return shown;
}

/** La acción que alterna según el último estado. */
const toggle = async ($: EngineInterface): Promise<Action> => ((await read($, status))?.mode === "remote" ? "off" : "on");

/** El refresco cada 30 s, uno por instancia del módulo. */
function arm($: EngineInterface): void {
  timer ??= $.clock.every(30_000, () => void companion($, "status", true));
}

/** Comando, reloj y primer estado; solo en la terminal, donde hay `$.process`. Repetirlo no duplica nada. */
async function mount($: EngineInterface): Promise<void> {
  if (!(await $.session.surfaces()).includes("terminal")) return;
  arm($);
  const t = textsOf(await companion($, "status", true));
  // Si el nombre está cogido (otra skill o comando `landinem`) el registro falla: la banda y su botón siguen.
  try {
    await $.command.register({
      name: "landinem",
      description: t.description,
      argumentHint: t.argumentHint,
    });
  } catch {
    // Sin comando.
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await mount($);
    return next(e);
  });

  // `/clear` no lanza `session.start` y cambia el id de la sesión; tras los hooks de comando el puntero ya existe.
  on("classic.SessionStart", async ($, e, next) => {
    const result = await next(e);
    // Sin esperar al acompañante: el resultado de los hooks de comando sale tal cual y en el acto.
    mount($).catch(() => {});
    return result;
  }).catch(($, e, next) => next(e));

  on("command.run", { command: "landinem" }, async ($, e) => {
    arm($);
    const arg = e.args.trim();
    // `estado` y `status` valen en los dos idiomas.
    if (arg !== "" && arg !== "on" && arg !== "off" && arg !== "estado" && arg !== "status") return { text: textsOf(await read($, status)).usage };
    const action = arg === "" ? await toggle($) : arg === "estado" ? "status" : arg;
    return { text: textOf(await companion($, action), action === "on") };
  });

  // En remoto, por cualquier camino (comando, botón, «Arrancar en remoto»), la declaración va al final del prompt de
  // sistema. Solo lee el estado guardado: nada de procesos al componer.
  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    const s = await read($, status);
    if (s?.mode !== "remote" || typeof s.declaration !== "string") return composed;
    return { sections: [...composed.sections, { id: "landinem:monitor", text: s.declaration, scope: "session" as const }] };
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.surface === "terminal") arm($);
    const s = await read($, status);
    if (e.surface !== "terminal" || e.props.hasSurvey || s === null) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    const t = textsOf(s);
    if (s.reason === "revoked")
      return (
        <Box>
          <Text dimColor>Landinem  {t.bandRevoked}</Text>
        </Box>
      );
    if (blocked(s))
      return (
        <Box>
          <Text dimColor>Landinem  {s.reason === "no_mcp" ? t.noMcp : t.bandSignIn}</Text>
        </Box>
      );
    const remote = s.mode === "remote";
    // Con espejos sin enviar, Landinem no contesta aunque el stream del monitor siga abierto.
    const live = remote && s.connected && !s.pending;
    const label = !remote ? t.bandLocal : s.pending ? t.bandOffline(s.pending) : s.connected ? t.bandRemote : t.bandConnecting;
    return (
      <Box>
        <Text>
          <Text dimColor>Landinem </Text>
          {live ? <Text color="success">●</Text> : <Text dimColor>{remote ? "◐" : "○"}</Text>}
          <Text dimColor>{label}</Text>
          {live && s.title ? `  ${s.title}` : ""}{" "}
        </Text>
        <Button key="landinem-modo" label={remote ? t.toLocal : t.toRemote} onPress={async () => companion($, await toggle($))} />
      </Box>
    );
  });
};
