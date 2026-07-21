import { chmod, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform !== "darwin") {
  process.exit(0);
}

const require = createRequire(import.meta.url);
let nodePtyRoot;
try {
  nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
} catch (error) {
  throw new Error("jinn-cli postinstall could not resolve node-pty/package.json", { cause: error });
}

async function fixPrebuilds(nodePtyRoot) {
  let platforms;
  try {
    platforms = await readdir(join(nodePtyRoot, "prebuilds"), {
      withFileTypes: true,
    });
  } catch (error) {
    throw new Error(`jinn-cli postinstall could not read node-pty prebuilds at ${nodePtyRoot}`, { cause: error });
  }

  const darwinPrebuilds = platforms.filter(
    (platform) => platform.isDirectory() && platform.name.startsWith("darwin-"),
  );
  if (darwinPrebuilds.length === 0) {
    throw new Error(`jinn-cli postinstall found no Darwin node-pty prebuilds at ${nodePtyRoot}`);
  }

  await Promise.all(darwinPrebuilds.map(async (platform) => {
    const helper = join(nodePtyRoot, "prebuilds", platform.name, "spawn-helper");
    try {
      await chmod(helper, 0o755);
    } catch (error) {
      throw new Error(`jinn-cli postinstall could not chmod node-pty helper ${helper}`, { cause: error });
    }
  }));
}

await fixPrebuilds(nodePtyRoot);
