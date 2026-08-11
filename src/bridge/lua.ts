/**
 * Compile-time enforcement of the no-splicing rule.
 *
 * The claim this project rests on is that tool arguments never reach the Lua
 * parser as code. That held because every Lua body was written as a static
 * constant, but nothing except a regex test stopped someone writing otherwise,
 * and an adversarial review found several ways past it (build the program with
 * `+`, launder it through a second variable, call the bridge through a
 * destructured `run`).
 *
 * So the rule moves into the type system. `HammerspoonBridge.run` accepts only
 * a `LuaProgram`, and the only way to obtain one is the `lua` tag below, whose
 * signature makes interpolation impossible to express:
 *
 *     const GOOD_LUA = lua`return hs.window.focusedWindow():id()`;   // fine
 *     const BAD_LUA  = lua`return ${something}`;                     // will not compile
 *
 * `...values: never[]` is what does the work. A tagged template with one
 * substitution calls the tag with that value as an argument, and no value is
 * assignable to `never`, so the call fails to type check. Concatenation,
 * `.join()`, `.replace()`, and plain strings all fail too, because none of
 * them produce the brand.
 *
 * This is a guardrail against mistakes, not against a hostile maintainer:
 * anyone who can commit can write `as LuaProgram`. That is the point. It makes
 * accidental splicing impossible and deliberate splicing a visible, reviewable
 * act rather than a quiet one.
 */

declare const luaProgramBrand: unique symbol;

/** A Lua program known to contain no interpolated values. */
export type LuaProgram = string & { readonly [luaProgramBrand]: true };

/**
 * Tags a static Lua source string.
 *
 * Accepts a template literal with no substitutions. Any `${...}` is a
 * compile error, which is the entire reason this exists.
 */
export function lua(source: TemplateStringsArray, ...values: never[]): LuaProgram {
  // values is always empty: the signature makes any other case unrepresentable.
  // Reading it keeps the parameter honest rather than decorative.
  if (values.length > 0) {
    throw new Error('lua templates cannot interpolate values');
  }
  return source.join('') as unknown as LuaProgram;
}

/**
 * Escape hatch for the one caller that legitimately has a Lua string it did
 * not write as a literal: tests that build a program dynamically on purpose.
 *
 * Deliberately verbose. If this appears in `src/`, that is a bug worth a
 * conversation, and the meta-test asserts it never does.
 */
export function unsafeLuaFromString(source: string): LuaProgram {
  return source as unknown as LuaProgram;
}
