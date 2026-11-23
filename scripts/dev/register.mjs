// `node --import ./scripts/dev/register.mjs …` installs the hooks in hooks.mjs.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
