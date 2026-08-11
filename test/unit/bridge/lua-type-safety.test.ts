/**
 * Compile-time tests for the no-splicing rule.
 *
 * Every `@ts-expect-error` below is an assertion. If the line it guards ever
 * starts compiling, TypeScript reports the directive itself as unused and the
 * typecheck fails. So this file breaks the build the moment a bypass opens up,
 * which is the opposite of the regex meta-test, where a bypass simply goes
 * unnoticed.
 *
 * Each case was demonstrated by an adversarial review to slip past those
 * regexes. All of them are rejected by the type system.
 *
 * The rejected forms live inside a function that is never called. They must be
 * type-checked but never executed: the `lua` tag throws when handed
 * substitutions, and the `bridge.run` calls would spawn subprocesses.
 */

import { describe, expect, it } from 'vitest';

import type { HammerspoonBridge } from '../../../src/bridge/bridge.js';
import { lua, unsafeLuaFromString } from '../../../src/bridge/lua.js';

const attacker = 'os.execute("rm -rf ~")';

/** Never invoked. Exists purely so the compiler reads the lines inside it. */
function rejectedForms(bridge: HammerspoonBridge): void {
  // ─── The lua tag rejects every form of interpolation ────────────────

  // @ts-expect-error interpolating a value into a Lua template is not expressible
  void lua`return ${attacker}`;

  // @ts-expect-error even a number cannot be interpolated
  void lua`return ${42}`;

  // @ts-expect-error interpolation anywhere in the template is rejected
  void lua`local x = ${attacker} return x`;

  // ─── bridge.run rejects anything that is not a branded program ──────

  // @ts-expect-error a plain string literal is not a LuaProgram
  void bridge.run('return 1');

  // @ts-expect-error a plain template literal is not a LuaProgram
  void bridge.run(`return 1`);

  // @ts-expect-error concatenation produces a string, not a LuaProgram
  void bridge.run('return ' + attacker);

  // @ts-expect-error join produces a string, not a LuaProgram
  void bridge.run(['return', attacker].join(' '));

  // @ts-expect-error replace degrades a valid program back to a plain string
  void bridge.run(lua`return PLACEHOLDER`.replace('PLACEHOLDER', attacker));

  // @ts-expect-error String.raw is not the lua tag
  void bridge.run(String.raw`return ${attacker}`);

  // Interpolating into a plain template gives a plain string, and assigning it
  // to a variable first does not change that.
  const laundered = `return ${attacker}`;
  // @ts-expect-error laundering through a variable does not launder the type
  void bridge.run(laundered);

  // Pulling the method off the object does not escape the parameter type. The
  // unbound-method rule describes exactly what this line is testing, so it is
  // disabled here rather than avoided.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { run } = bridge;
  // @ts-expect-error calling through an alias keeps the LuaProgram requirement
  void run.call(bridge, 'return 1');
}

// ─── What IS allowed ──────────────────────────────────────────────────

const STATIC_LUA = lua`return hs.window.focusedWindow()`;
const MULTILINE_LUA = lua`
local out = {}
return out
`;

describe('LuaProgram type', () => {
  it('accepts a static template with no substitutions', () => {
    expect(STATIC_LUA).toContain('focusedWindow');
    expect(MULTILINE_LUA).toContain('local out');
  });

  it('produces the source verbatim', () => {
    expect(lua`return 1`).toBe('return 1');
  });

  // Belt and braces: the type makes interpolation unrepresentable, and the
  // implementation refuses it too, in case someone reaches the tag through an
  // untyped path such as a JavaScript consumer.
  it('throws at runtime if interpolation somehow reaches it', () => {
    const untyped = lua as unknown as (s: TemplateStringsArray, ...v: unknown[]) => string;
    expect(() => untyped(['a', 'b'] as unknown as TemplateStringsArray, 'evil')).toThrow(
      /cannot interpolate/i
    );
  });

  // The escape hatch exists for tests that build Lua deliberately. It is named
  // to be conspicuous, and the meta-test asserts src/ never uses it.
  it('provides a named escape hatch rather than an anonymous cast', () => {
    expect(unsafeLuaFromString(`return ${1 + 1}`)).toBe('return 2');
  });

  it('keeps the rejected forms compiled but unexecuted', () => {
    expect(typeof rejectedForms).toBe('function');
  });
});
