// `npm run dev`: the Node dev server (API, MCP, tracker, built assets) plus the Vite dashboard with HMR.
import { spawn } from "node:child_process";

const run = (cmd, args, env = {}) => spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
const api = run("npm", ["run", "dev:api"]);
const ui = run("npm", ["run", "dev:dashboard"], { PULSE_DEV_API: "http://localhost:8787" });
const stop = () => {
  api.kill();
  ui.kill();
  process.exit();
};
process.on("SIGINT", stop);
api.on("exit", stop);
ui.on("exit", stop);
