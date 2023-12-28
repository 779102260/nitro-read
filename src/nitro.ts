import { existsSync } from "node:fs";
import { resolve, normalize } from "pathe";
import { createHooks, createDebugger } from "hookable";
import { createUnimport } from "unimport";
import { defu } from "defu";
import { consola } from "consola";
import type { NitroConfig, NitroDynamicConfig, Nitro } from "./types";
import {
  LoadConfigOptions,
  loadOptions,
  normalizeRouteRules,
  normalizeRuntimeConfig,
} from "./options";
import { scanModules, scanPlugins, scanTasks } from "./scan";
import { createStorage } from "./storage";
import { resolveNitroModule } from "./module";

export async function createNitro(
  config: NitroConfig = {},
  opts: LoadConfigOptions = {}
): Promise<Nitro> {
  // Resolve options
  const options = await loadOptions(config, opts);

  // Create context
  const nitro: Nitro = {
    options,
    hooks: createHooks(),
    vfs: {},
    logger: consola.withTag("nitro"),
    scannedHandlers: [],
    close: () => nitro.hooks.callHook("close"),
    storage: undefined,
    async updateConfig(config: NitroDynamicConfig) {
      nitro.options.routeRules = normalizeRouteRules(
        config.routeRules ? config : nitro.options
      );
      nitro.options.runtimeConfig = normalizeRuntimeConfig(
        config.runtimeConfig ? config : nitro.options
      );
      await nitro.hooks.callHook("rollup:reload");
      consola.success("Nitro config hot reloaded!");
    },
  };

  // Storage
  // TODO 创建存储实例
  nitro.storage = await createStorage(nitro);
  nitro.hooks.hook("close", async () => {
    await nitro.storage.dispose();
  });

  if (nitro.options.debug) {
    createDebugger(nitro.hooks, { tag: "nitro" });
    nitro.options.plugins.push("#internal/nitro/debug");
  }

  if (nitro.options.timing) {
    nitro.options.plugins.push("#internal/nitro/timing");
  }

  // Logger config
  if (nitro.options.logLevel !== undefined) {
    nitro.logger.level = nitro.options.logLevel;
  }

  // Init hooks
  nitro.hooks.addHooks(nitro.options.hooks);

  // Public assets
  // 静态资源：查找静态资源目录（除了根目录，还从scanDirs查找）-> 放到routeRules中（比如/public/**）
  for (const dir of options.scanDirs) {
    const publicDir = resolve(dir, "public");
    if (!existsSync(publicDir)) {
      continue;
    }
    if (options.publicAssets.some((asset) => asset.dir === publicDir)) {
      continue;
    }
    options.publicAssets.push({ dir: publicDir } as any);
  }
  for (const asset of options.publicAssets) {
    asset.baseURL = asset.baseURL || "/";
    const isTopLevel = asset.baseURL === "/";
    asset.fallthrough = asset.fallthrough ?? isTopLevel;
    // route规则
    const routeRule = options.routeRules[asset.baseURL + "/**"];
    // 缓存时长
    asset.maxAge =
      (routeRule?.cache as { maxAge: number })?.maxAge ?? asset.maxAge ?? 0;
    if (asset.maxAge && !asset.fallthrough) {
      // TODO 合并对象
      options.routeRules[asset.baseURL + "/**"] = defu(routeRule, {
        headers: {
          "cache-control": `public, max-age=${asset.maxAge}, immutable`,
        },
      });
    }
  }

  // Server assets
  // 服务端静态资源：添加默认assets目录
  nitro.options.serverAssets.push({
    baseName: "server",
    dir: resolve(nitro.options.srcDir, "assets"),
  });

  // Plugins
  // 插件：扫描插件目录文件 -> 添加到options.plugins
  const scannedPlugins = await scanPlugins(nitro);
  for (const plugin of scannedPlugins) {
    if (!nitro.options.plugins.includes(plugin)) {
      nitro.options.plugins.push(plugin);
    }
  }

  // Tasks
  // TODO 干嘛的 
  // 任务：扫描任务目录文件 -> 添加到options.tasks
  const scannedTasks = await scanTasks(nitro);
  for (const scannedTask of scannedTasks) {
    if (scannedTask.name in nitro.options.tasks) {
      if (!nitro.options.tasks[scannedTask.name].handler) {
        nitro.options.tasks[scannedTask.name].handler = scannedTask.handler;
      }
    } else {
      nitro.options.tasks[scannedTask.name] = {
        handler: scannedTask.handler,
        description: "",
      };
    }
  }
  const taskNames = Object.keys(nitro.options.tasks).sort();
  if (taskNames.length > 0) {
    consola.warn(
      `Nitro tasks are experimental and API may change in the future releases!`
    );
    consola.log(
      `Available Tasks:\n\n${taskNames
        .map(
          (t) =>
            ` - \`${t}\`${
              nitro.options.tasks[t].description
                ? ` - ${nitro.options.tasks[t].description}`
                : ""
            }`
        )
        .join("\n")}`
    );
  }
  nitro.options.virtual["#internal/nitro/virtual/tasks"] = () => `
export const tasks = {
  ${Object.entries(nitro.options.tasks)
    .map(
      ([name, task]) =>
        `"${name}": {
          description: ${JSON.stringify(task.description)},
          get: ${
            task.handler
              ? `() => import("${normalize(task.handler)}")`
              : "undefined"
          },
        }`
    )
    .join(",\n")}
};
  `;

  // Auto imports
  // TODO 自动导入 
  if (nitro.options.imports) {
    nitro.unimport = createUnimport(nitro.options.imports);
    await nitro.unimport.init();
    // Support for importing from '#imports'
    nitro.options.virtual["#imports"] = () => nitro.unimport.toExports();
    // Backward compatibility
    nitro.options.virtual["#nitro"] = 'export * from "#imports"';
  }

  // Resolve and run modules after initial setup
  // TODO 干嘛的
  const scannedModules = await scanModules(nitro);
  const _modules = [...(nitro.options.modules || []), ...scannedModules];
  const modules = await Promise.all(
    _modules.map((mod) => resolveNitroModule(mod, nitro.options))
  );
  const _installedURLs = new Set<string>();
  for (const mod of modules) {
    if (mod._url) {
      if (_installedURLs.has(mod._url)) {
        continue;
      }
      _installedURLs.add(mod._url);
    }
    await mod.setup(nitro);
  }

  return nitro;
}
