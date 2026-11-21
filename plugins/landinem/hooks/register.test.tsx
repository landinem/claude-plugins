import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";

type Reply = { mode: "local" | "remote"; connected: boolean; title: string | null; reason?: string; declaration?: string; pending?: number };

const SESSION = "0b6f2d3e-sesion";
const BAND = {
  plugin: "landinem",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

/** El motor bajo el mod: sesión, comando y un acompañante de mentira que anota cada `argv`. */
function engine(on: On, answer: (action: string) => Reply | "fail" | "deny" | "garbage", surfaces: Array<"terminal" | "desktop"> = ["terminal"], nameTaken = false) {
  const calls: string[][] = [];
  const clock = mock.clock(on);
  on("session.surfaces", () => ({ value: surfaces }));
  on("session.id", () => ({ value: SESSION }));
  on("command.register", () => (nameTaken ? { deny: "nombre cogido" } : { value: { command: "landinem" } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("prompt.compose", () => ({ sections: [{ id: "intro", text: "INTRO", scope: "shared" }] }));
  on("process.run", (_, e) => {
    calls.push([...e.argv]);
    const reply = answer(e.argv[3] ?? "");
    const out = { stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
    if (reply === "deny") return { deny: "node no arranca" };
    if (reply === "fail") return { value: { ...out, exitCode: 1, stdout: "", stderr: "boom" } };
    if (reply === "garbage") return { value: { ...out, exitCode: 0, stdout: "{not json\n[1,2]\n" } };
    return { value: { ...out, exitCode: 0, stdout: `aviso\n${JSON.stringify(reply)}\n` } };
  });
  return { calls, clock };
}

/** El acompañante con estado: `on` pasa a remoto conectado, `off` a local; en remoto trae la declaración. */
const companion = () => {
  let remote = false;
  return (action: string): Reply => {
    if (action === "on") remote = true;
    if (action === "off") remote = false;
    return remote
      ? { mode: "remote", connected: true, title: "prueba-name", declaration: "DECLARACION" }
      : { mode: "local", connected: false, title: null };
  };
};

/** Cuántas veces lleva el prompt de sistema la declaración, y en qué sección. */
const FACTS = { model: "m", promptModel: "m", surfaces: ["terminal"], tools: [], outputStyle: null, traits: [] } as const;
const compose = ($: Engine) => $.prompt.compose(FACTS);
const declared = async ($: Engine) => (await compose($)).sections.filter((sec) => sec.text.includes("DECLARACION"));

const start = ($: Engine) => $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
const landinem = async ($: Engine, args: string) =>
  (await $.command.run({ command: "landinem", args, origin: { kind: "composer" }, presentation: { layout: "main", columns: 80 } } as never)).text;

test("al cargar pide el estado y la banda dice local con Activar remoto", async ($, on) => {
  const { calls } = engine(on, companion());
  await start($);
  expect(calls).toEqual([["node", expect.stringMatching(/\/dist\/landinem-companion\.mjs$/), "remote", "status", "--session", SESSION]]);
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /○ local/ }))?.text).toContain("Landinem");
  expect(await ui.find({ type: "Button", text: "Activar remoto" })).toBeDefined();
  await ui.unmount();
});

test("el botón pasa a remoto y la banda enseña el título", async ($, on) => {
  const { calls } = engine(on, companion());
  await start($);
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "landinem-modo" });
  expect(calls.map((argv) => argv[3])).toEqual(["status", "on"]);
  expect((await ui.find({ type: "Text", text: /● remoto/ }))?.text).toMatch(/^Landinem ● remoto {2}prueba-name\s*$/);
  expect(await ui.find({ type: "Button", text: "Pasar a local" })).toBeDefined();
  await ui.unmount();
});

test("/landinem alterna, estado pide status y otro argumento responde el uso", async ($, on) => {
  const { calls } = engine(on, companion());
  await start($);
  expect(await landinem($, "")).toBe("Landinem: sesión en remoto. Sale en Chats y recibe mensajes de la web.\n\nDECLARACION");
  expect(await landinem($, "")).toBe("Landinem: sesión en local. Las tools siguen disponibles y no sale en Chats.");
  expect(await landinem($, "estado")).toBe("Landinem: sesión en local. Las tools siguen disponibles y no sale en Chats.");
  expect(calls.map((argv) => argv[3])).toEqual(["status", "on", "off", "status"]);
  expect(await landinem($, "x")).toBe("Uso: /landinem [on|off|estado]");
  expect(calls).toHaveLength(4);
});

test("al pasar a remoto con /landinem la respuesta lleva la declaración del monitor, sin título ni nada más", async ($, on) => {
  engine(on, companion());
  await start($);
  expect(await landinem($, "on")).toBe("Landinem: sesión en remoto. Sale en Chats y recibe mensajes de la web.\n\nDECLARACION");
  expect(await landinem($, "estado")).toBe("Landinem: sesión en remoto. Sale en Chats y recibe mensajes de la web.");
});

test("en remoto el prompt de sistema lleva la declaración una vez, al final y por sesión; en local no", async ($, on) => {
  engine(on, companion());
  await start($);
  expect(await declared($)).toEqual([]);
  await landinem($, "on");
  expect(await declared($)).toEqual([{ id: "landinem:monitor", text: "DECLARACION", scope: "session" }]);
  const { sections } = await compose($);
  expect(sections.map((sec) => sec.id)).toEqual(["intro", "landinem:monitor"]);
  await landinem($, "off");
  expect(await declared($)).toEqual([]);
  expect((await compose($)).sections).toEqual([{ id: "intro", text: "INTRO", scope: "shared" }]);
});

test("al pasar a remoto con el botón (sin comando) el prompt de sistema también la lleva", async ($, on) => {
  engine(on, companion());
  await start($);
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "landinem-modo" });
  expect(await declared($)).toHaveLength(1);
  await ui.press({ key: "landinem-modo" });
  expect(await declared($)).toEqual([]);
  await ui.unmount();
});

test("con Arrancar en remoto y la cuenta sin conectar la banda dice sin conectar y lo quita al conectar el monitor", async ($, on) => {
  let signedIn = false;
  const { clock } = engine(on, () => ({ mode: "remote", connected: signedIn, title: "prueba-name", ...(signedIn ? {} : { reason: "sign_in" }) }));
  await start($);
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /sin conectar: abre \/mcp y pulsa Authenticate/ })).toBeDefined();
  signedIn = true;
  await clock.advance(30_000);
  expect((await ui.find({ type: "Text", text: /● remoto/ }))?.text).toMatch(/^Landinem ● remoto {2}prueba-name\s*$/);
  await ui.unmount();
});

test("sin la cuenta conectada la banda y el comando mandan a /mcp, sin botón, y el reloj no lo borra", async ($, on) => {
  // Como el acompañante real: `on` falla con sign_in; `status` solo dice local.
  const { clock } = engine(on, (action) => ({ mode: "local", connected: false, title: null, ...(action === "on" ? { reason: "sign_in" } : {}) }));
  await start($);
  expect(await landinem($, "on")).toBe("Landinem: falta conectar la cuenta. Abre /mcp, elige landinem y pulsa Authenticate.");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /sin conectar: abre \/mcp y pulsa Authenticate/ })).toBeDefined();
  expect(await ui.find({ type: "Button" })).toBeUndefined();
  await clock.advance(30_000);
  expect(await ui.find({ type: "Text", text: /sin conectar: abre \/mcp y pulsa Authenticate/ })).toBeDefined();
  // Una acción explícita sí lo borra.
  expect(await landinem($, "estado")).toBe("Landinem: sesión en local. Las tools siguen disponibles y no sale en Chats.");
  expect(await ui.find({ type: "Text", text: /○ local/ })).toBeDefined();
  await ui.unmount();
});

test("si el MCP del plugin no ha conectado en el proceso la banda y el comando dicen cómo arreglarlo, sin botón", async ($, on) => {
  engine(on, (action) => ({ mode: "local", connected: false, title: null, ...(action === "on" ? { reason: "no_mcp" } : {}) }));
  await start($);
  expect(await landinem($, "on")).toBe(
    "Landinem: sin conectar: abre /mcp y autentica plugin:landinem:landinem. Si no sale en la lista, quita o desactiva el otro MCP landinem y reinicia Claude Code.",
  );
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /autentica plugin:landinem:landinem\. Si no sale en la lista, quita o desactiva el otro MCP landinem/ })).toBeDefined();
  expect(await ui.find({ type: "Button" })).toBeUndefined();
  await ui.unmount();
});

test("si el comando no se puede registrar la banda sale igual desde el arranque", async ($, on) => {
  const { calls } = engine(on, companion(), ["terminal"], true);
  await start($);
  expect(calls.map((argv) => argv[3])).toEqual(["status"]);
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /○ local/ })).toBeDefined();
  await ui.unmount();
});

test("si el acompañante falla queda unavailable y la banda sigue en local", async ($, on) => {
  engine(on, () => "fail");
  await start($);
  expect(await landinem($, "on")).toBe("Landinem: no se pudo cambiar el modo. Inténtalo de nuevo en unos segundos.");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /○ local/ })).toBeDefined();
  await ui.unmount();
});

test("fuera de la terminal la banda no se dibuja", async ($, on) => {
  engine(on, companion());
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>motor</Text>;
  });
  await start($);
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });
  expect(await ui.find({ type: "Text", text: /Landinem/ })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /motor/ })).toBeDefined();
  await ui.unmount();
});

test("en una sesión sin terminal no lanza el acompañante", async ($, on) => {
  const { calls } = engine(on, companion(), ["desktop"]);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  expect(calls).toEqual([]);
});

test("tras /clear vuelve a pedir el estado y el resultado de los hooks de comando sale intacto", async ($, on) => {
  const { calls, clock } = engine(on, companion());
  on("classic.SessionStart", () => ({ additionalContext: ["CTX"] }));
  await start($);
  expect(await $.classic.SessionStart({ source: "clear" })).toEqual({ additionalContext: ["CTX"] });
  await clock.settle();
  expect(calls.map((argv) => argv[3])).toEqual(["status", "status"]);
});

test("H40: con el dispositivo revocado la banda y el comando lo dicen y mandan a /mcp, Authenticate", async ($, on) => {
  engine(on, () => ({ mode: "remote", connected: false, title: "prueba-name", reason: "revoked" }));
  await start($);
  expect(await landinem($, "estado")).toBe(
    "Landinem: este dispositivo está revocado. Abre /mcp, elige plugin:landinem:landinem y pulsa Authenticate para conectarlo de nuevo.",
  );
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /revocado/ }))?.text).toMatch(/^Landinem {2}dispositivo revocado: abre \/mcp y pulsa Authenticate\s*$/);
  expect(await ui.find({ type: "Text", text: /conectando/ })).toBeUndefined();
  await ui.unmount();
});

test("H37: con espejos sin enviar la banda dice que no hay conexión aunque el monitor siga conectado", async ($, on) => {
  engine(on, () => ({ mode: "remote", connected: true, title: "prueba-name", pending: 2 }));
  await start($);
  expect(await landinem($, "estado")).toBe(
    "Landinem: sesión en remoto, pero Landinem no contesta: 2 mensajes esperan para llegar al chat y se envían solos cuando vuelva.",
  );
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /◐/ }))?.text).toMatch(/^Landinem ◐ remoto, sin conexión \(2 sin enviar\)\s*$/);
  expect(await ui.find({ type: "Text", text: /●/ })).toBeUndefined();
  expect(await ui.find({ type: "Button", text: "Pasar a local" })).toBeDefined();
  await ui.unmount();
});

test("H37: con un solo espejo sin enviar el comando habla en singular", async ($, on) => {
  engine(on, () => ({ mode: "remote", connected: true, title: "prueba-name", pending: 1 }));
  await start($);
  expect(await landinem($, "estado")).toBe(
    "Landinem: sesión en remoto, pero Landinem no contesta: 1 mensaje espera para llegar al chat y se envía solo cuando vuelva.",
  );
});

test("en remoto sin monitor conectado la banda dice conectando", async ($, on) => {
  engine(on, () => ({ mode: "remote", connected: false, title: "prueba-name" }));
  await start($);
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /◐/ }))?.text).toMatch(/^Landinem ◐ remoto, conectando\s*$/);
  expect(await ui.find({ type: "Button", text: "Pasar a local" })).toBeDefined();
  await ui.unmount();
});

test("cada 30 s pide el estado una vez, con un solo reloj aunque arranque dos veces", async ($, on) => {
  const { calls, clock } = engine(on, companion());
  await start($);
  await start($);
  expect(calls.map((argv) => argv[3])).toEqual(["status", "status"]);
  await clock.advance(30_000);
  expect(calls.map((argv) => argv[3])).toEqual(["status", "status", "status"]);
  await clock.advance(30_000);
  expect(calls).toHaveLength(4);
});

for (const failure of ["deny", "garbage"] as const) {
  test(`un acompañante que ${failure === "deny" ? "no arranca" : "responde basura"} deja unavailable y conserva el modo`, async ($, on) => {
    let broken = false;
    const ok = companion();
    engine(on, (action) => (broken ? failure : ok(action)));
    await start($);
    expect(await landinem($, "on")).toBe("Landinem: sesión en remoto. Sale en Chats y recibe mensajes de la web.\n\nDECLARACION");
    broken = true;
    expect(await landinem($, "estado")).toBe("Landinem: no se pudo cambiar el modo. Inténtalo de nuevo en unos segundos.");
    const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
    expect(await ui.find({ type: "Text", text: /● remoto/ })).toBeDefined();
    expect(await ui.find({ type: "Button", text: "Pasar a local" })).toBeDefined();
    await ui.unmount();
  });
}
