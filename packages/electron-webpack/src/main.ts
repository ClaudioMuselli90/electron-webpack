import * as BluebirdPromise from "bluebird"
import { config as dotEnvConfig } from "dotenv"
import dotEnvExpand from "dotenv-expand"
import { pathExists, readJson } from "fs-extra"
import { Lazy } from "lazy-val"
import * as path from "path"
import { deepAssign } from "read-config-file/out/deepAssign"
import "source-map-support/register"
import { Configuration, WebpackPluginInstance , RuleSetRule } from "webpack"
import merge from "webpack-merge"
import { getElectronWebpackConfiguration, getPackageMetadata } from "./config"
import { configureTypescript } from "./configurators/ts"
import { configureVue } from "./configurators/vue/vue"
import { ConfigurationEnv, ConfigurationType, ElectronWebpackConfiguration, PackageMetadata, PartConfiguration } from "./core"
import { BaseTarget } from "./targets/BaseTarget"
import { MainTarget } from "./targets/MainTarget"
import { BaseRendererTarget, RendererTarget } from "./targets/RendererTarget"
import { getFirstExistingFile } from "./util"

export { ElectronWebpackConfiguration } from "./core"

const _debug = require("debug")

// noinspection JSUnusedGlobalSymbols
export function getAppConfiguration(env: ConfigurationEnv) {
  return BluebirdPromise.filter([configure("main", env), configure("renderer", env)], it => it != null)
}

// noinspection JSUnusedGlobalSymbols
export function getMainConfiguration(env: ConfigurationEnv) {
  return configure("main", env)
}

// noinspection JSUnusedGlobalSymbols
export function getRendererConfiguration(env: ConfigurationEnv) {
  return configure("renderer", env)
}

// in the future, if need, isRenderer = true arg can be added
// noinspection JSUnusedGlobalSymbols
export function getDllConfiguration(env: ConfigurationEnv) {
  return configure("renderer-dll", env)
}

// noinspection JSUnusedGlobalSymbols
export async function getTestConfiguration(env: ConfigurationEnv) {
  const configurator = await createConfigurator("test", env)
  return await configurator.configure({
    testComponents: path.join(process.cwd(), "src/renderer/components/testComponents.ts"),
  })
}

export class WebpackConfigurator {
  readonly projectDir: string

  private electronVersionPromise = new Lazy(() => getInstalledElectronVersion(this.projectDir))

  readonly isRenderer: boolean
  readonly isProduction: boolean
  readonly isTest = this.type === "test"

  readonly sourceDir: string
  readonly staticSourceDirectory: string
  readonly commonSourceDirectory: string
  readonly commonDistDirectory: string

  readonly rendererTemplate: string

  readonly debug = _debug(`electron-webpack:${this.type}`)

  private _configuration: Configuration | null = null

  get config(): Configuration {
    return this._configuration!!
  }

  readonly rules: Array<RuleSetRule> = []
  readonly plugins: Array<WebpackPluginInstance > = []

  // js must be first - e.g. iView has two files loading-bar.js and loading-bar.vue - when we require "loading-bar", js file must be resolved and not vue
  readonly extensions: Array<string> = [".js", ".json", ".node"]

  private _electronVersion: string | null = null

  get electronVersion(): string {
    return this._electronVersion!!
  }

  readonly entryFiles: Array<string> = []

  // electronWebpackConfiguration expected to be resolved (use getElectronWebpackConfiguration())
  constructor(readonly type: ConfigurationType, readonly env: ConfigurationEnv, readonly electronWebpackConfiguration: ElectronWebpackConfiguration, readonly metadata: PackageMetadata) {
    if (metadata.dependencies == null) {
      metadata.dependencies = {}
    }
    if (metadata.devDependencies == null) {
      metadata.devDependencies = {}
    }

    this.projectDir = electronWebpackConfiguration.projectDir!!
    this.isRenderer = type.startsWith("renderer")
    process.env.BABEL_ENV = type

    this.isProduction = this.env.production == null ? process.env.NODE_ENV === "production" : this.env.production

    this.debug(`isProduction: ${this.isProduction}`)

    this.sourceDir = this.getSourceDirectory(this.type)!!

    this.staticSourceDirectory = this.electronWebpackConfiguration.staticSourceDirectory!!
    this.commonSourceDirectory = this.electronWebpackConfiguration.commonSourceDirectory!!
    this.commonDistDirectory = this.electronWebpackConfiguration.commonDistDirectory!!

    this.rendererTemplate = (this.electronWebpackConfiguration.renderer && this.electronWebpackConfiguration.renderer.template) || "src/index.ejs"
  }

  /**
   * Returns null if code processing for type is disabled.
   */
  getSourceDirectory(type: ConfigurationType): string | null {
    const part = this.getPartConfiguration(type)
    if (part === null || (part != null && part.sourceDirectory === null)) {
      // part or sourceDirectory is explicitly set to null
      return null
    }

    const result = part == null ? null : part.sourceDirectory
    if (result == null) {
      return path.join(this.projectDir, "src", type.startsWith("renderer") || type === "test" ? "renderer" : type)
    }
    else {
      return path.resolve(this.projectDir, result)
    }
  }

  getPartConfiguration(type: ConfigurationType): PartConfiguration | null | undefined {
    if (type === "main") {
      return this.electronWebpackConfiguration.main
    }
    else {
      return this.electronWebpackConfiguration.renderer
    }
  }

  hasDependency(name: string) {
    return name in this.metadata.dependencies || this.hasDevDependency(name)
  }

  hasDevDependency(name: string) {
    return name in this.metadata.devDependencies
  }

  /**
   * Returns the names of devDependencies that match a given string or regex.
   * If no matching dependencies are found, an empty array is returned.
   *
   * @return list of matching dependency names, e.g. `["@babel/preset-react", "@babel/preset-stage-0"]`
   */
  getMatchingDevDependencies(options: GetMatchingDevDependenciesOptions = {}) {
    const includes = options.includes || []
    const excludes = new Set(options.excludes || [])
    return Object.keys(this.metadata.devDependencies)
      .filter(name => !excludes.has(name) && includes.some(prefix => name.startsWith(prefix)))
  }

  async configure(entry?: { [key: string]: any } | null) {
    // noinspection SpellCheckingInspection
    this._configuration = {
      context: this.projectDir,
      devtool: this.isProduction || this.isTest ? "nosources-source-map" : "eval-source-map",
      externals: this.computeExternals(),
      node: {
        __dirname: !this.isProduction,
        __filename: !this.isProduction,
      },
      output: {
        filename: "[name].js",
        chunkFilename: "[name].bundle.js",
        libraryTarget: "commonjs2",
        path: path.join(this.commonDistDirectory, this.type)
      },
      target: this.isTest ? "node" : `electron-${this.type === "renderer-dll" ? "renderer" : this.type}` as any,
      resolve: {
        alias: {
          "@": this.sourceDir,
          common: this.commonSourceDirectory,
        },
        extensions: this.extensions,
      },
      module: {
        rules: this.rules,
      },
      plugins: this.plugins,
    }

    if (entry != null) {
      this._configuration.entry = entry
    }

    // if electronVersion not specified, use latest
    this._electronVersion = this.electronWebpackConfiguration.electronVersion || await this.electronVersionPromise.value || "3.0.7"
    const target = (() => {
      switch (this.type) {
        case "renderer": return new RendererTarget()
        case "renderer-dll": return new BaseRendererTarget()
        case "test": return new BaseRendererTarget()
        case "main": return new MainTarget()
        default: return new BaseTarget()
      }
    })()
    this.debug(`Target class: ${target.constructor.name}`)
    target.configureRules(this)
    await Promise.all([target.configurePlugins(this), configureTypescript(this)])
    configureVue(this)

    if (this.debug.enabled) {
      this.debug(`\n\n${this.type} config:` + JSON.stringify(this._configuration, null, 2) + "\n\n")
    }

    if (this.config.entry == null) {
      this.entryFiles.push((await computeEntryFile(this.sourceDir, this.projectDir))!!)
      this.config.entry = {
        [this.type]: this.entryFiles,
      }

      const mainConfiguration = this.electronWebpackConfiguration.main || {}
      let extraEntries = mainConfiguration.extraEntries
      if (this.type === "main" && extraEntries != null) {
        if (typeof extraEntries === "string") {
          extraEntries = [extraEntries]
        }

        if (Array.isArray(extraEntries)) {
          for (const p of extraEntries) {
            this.config.entry[path.basename(p, path.extname(p))] = p
          }
        }
        else {
          Object.assign(this.config.entry, extraEntries)
        }
      }
    }

    // noinspection ES6RedundantAwait
    this._configuration = await Promise.resolve(this.applyCustomModifications(this.config))

    return this.config
  }

  private applyCustomModifications(config: Configuration): Configuration {
    const { renderer, main } = this.electronWebpackConfiguration

    const applyCustom = (configPath: string) => {
      const customModule = require(path.join(this.projectDir, configPath))
      if (typeof customModule === "function") {
        return customModule(config, this)
      }
      else {
        return merge(config, customModule)
      }
    }

    if (this.type === "renderer" && renderer && renderer.webpackConfig) {
      return applyCustom(renderer.webpackConfig)
    }
    else if (this.type === "renderer-dll" && renderer && renderer.webpackDllConfig) {
      return applyCustom(renderer.webpackDllConfig)
    }
    else if (this.type === "main" && main && main.webpackConfig) {
      return applyCustom(main.webpackConfig)
    }
    else {
      return config
    }
  }

  private computeExternals() {
    const whiteListedModules = new Set(this.electronWebpackConfiguration.whiteListedModules || [])
    if (this.isRenderer) {
      whiteListedModules.add("react")
      whiteListedModules.add("react-dom")
      whiteListedModules.add("vue")
    }

    const filter = (name: string) => !name.startsWith("@types/") && (whiteListedModules == null || !whiteListedModules.has(name))
    const externals: Array<string> = Object.keys(this.metadata.dependencies).filter(filter)
    externals.push("electron")
    externals.push("webpack")
    // because electron-devtools-installer specified in the devDependencies, but required in the index.dev
    externals.push("electron-devtools-installer")
    if (this.type === "main") {
      externals.push("webpack/hot/log-apply-result")
      externals.push("electron-webpack/out/electron-main-hmr/HmrClient")
      externals.push("source-map-support/source-map-support.js")
    }

    if (this.electronWebpackConfiguration.externals != null) {
      return externals.concat(this.electronWebpackConfiguration.externals)
    }

    return externals
  }
}

export async function createConfigurator(type: ConfigurationType, env: ConfigurationEnv | null) {
  if (env != null) {
    // allow to pass as `--env.autoClean=false` webpack arg
    const _env: any = env
    for (const name of ["minify", "autoClean", "production"]) {
      if (_env[name] === "true") {
        _env[name] = true
      }
      else if (_env[name] === "false") {
        _env[name] = false
      }
    }
  }

  if (env == null) {
    env = {}
  }

  const projectDir = (env.configuration || {}).projectDir || process.cwd()
  const packageMetadata = getPackageMetadata(projectDir)
  const electronWebpackConfig = await getElectronWebpackConfiguration({
    packageMetadata,
    projectDir,
  })
  if (env.configuration != null) {
    deepAssign(electronWebpackConfig, env.configuration)
  }
  return new WebpackConfigurator(type, env, electronWebpackConfig, await packageMetadata.value)
}

export async function configure(type: ConfigurationType, env: ConfigurationEnv | null): Promise<Configuration | null> {
  const configurator = await createConfigurator(type, env)
  const sourceDir = configurator.sourceDir
  // explicitly set to null - do not handle at all and do not show info message
  if (sourceDir === null) {
    return null
  }

  const processEnv = configurator.isProduction ? "production" : "development"
  const dotEnvPath = path.resolve(configurator.projectDir, ".env")
  const dotenvFiles = [
    `${dotEnvPath}.${processEnv}.local`,
    `${dotEnvPath}.${processEnv}`,
    `${dotEnvPath}.local`,
    dotEnvPath,
  ]

  for (const file of dotenvFiles) {
    const exists = await pathExists(file)
    if (exists) {
      dotEnvExpand.expand(
        dotEnvConfig({
          path: file
        })
      )
    }
  }
  return await configurator.configure()
}

async function computeEntryFile(srcDir: string, projectDir: string): Promise<string | null> {
  const candidates: Array<string> = []
  for (const ext of ["ts", "js", "tsx", "jsx"]) {
    for (const name of ["index", "main", "app"]) {
      candidates.push(`${name}.${ext}`)
    }
  }

  const file = await getFirstExistingFile(candidates, srcDir)
  if (file == null) {
    throw new Error(`Cannot find entry file ${path.relative(projectDir, path.join(srcDir, "index.ts"))} (or main.ts, or app.ts, or index.js, or main.js, or app.js)`)
  }
  return file
}

async function getInstalledElectronVersion(projectDir: string) {
  for (const name of ["electron", "electron-prebuilt", "electron-prebuilt-compile"]) {
    try {
      return (await readJson(path.join(projectDir, "node_modules", name, "package.json"))).version
    }
    catch (e: any) {
      if (e.code !== "ENOENT") {
        throw e
      }
    }
  }
}

export interface GetMatchingDevDependenciesOptions {
  /**
   * The list of prefixes to include, e.g. `["babel-preset-"]`.
   */
  includes?: Array<string>
  /**
   * The list of names to exclude.
   */
  excludes?: Array<string>
}
