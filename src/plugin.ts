/// <reference path="@types/index.d.ts" />

import path = require("path")
import os = require("os")
import cluster = require("cluster")
import Bluebird = require("bluebird")
import fs = require("fs")
import unixify = require("unixify")
import _ = require("lodash")
import linez = require("linez")
import spinner = require("cli-spinner")
import logger = require("./logger")
import util = require("./util")
import log_helper = require("./plugin/log_helper")

Bluebird.promisifyAll(fs)

const log = logger.create("plugin")

const Spinner = spinner.Spinner

const FILE_EXT = /\.[^\.]*$/

const is_plugin = (name) =>
  /^vile-/.test(name)

const valid_plugin = (api) =>
  api && typeof api.punish == "function"

const is_array = (list) =>
  list && typeof list.forEach == "function"

const is_promise = (list) =>
  list && typeof list.then == "function"

const log_error = (e : NodeJS.ErrnoException) => {
  console.log()
  log.error(e.stack || e)
}

const error_executing_plugins = (err : NodeJS.ErrnoException) => {
  log.error("Error executing plugins")
  log.error(err.stack || err)
  process.exit(1)
}

const require_plugin = (name : string) : vile.Plugin => {
  let cwd_node_modules = path.join(process.cwd(), "node_modules")

  try {
    return require(`${cwd_node_modules}/@forthright/vile-${name}`)
  } catch (e) {
    log_error(e)
  }
}

const map_plugin_name_to_issues = (name : string) => (issues : vile.Issue[]) =>
  _.map(issues, (issue : vile.Issue) =>
    (issue.plugin = name, issue))

const run_plugin = (
  name : string,
  config : vile.PluginConfig = {
    config: {},
    ignore: []
  }
) : Bluebird<any> =>
  new Bluebird((resolve, reject) => {
    let api : vile.Plugin = require_plugin(name)

    if (!valid_plugin(api)) {
      return Bluebird.reject(`invalid plugin API: ${name}`)
    }

    let issues : any = api.punish(config)

    if (is_promise(issues)) {
      issues
        .then(map_plugin_name_to_issues(name))
        .then(resolve)
        .catch(reject) // TODO: keep running other plugins?
    } else if (is_array(issues)) {
      resolve(map_plugin_name_to_issues(name)(issues))
    } else {
      log.warn(`${name} plugin did not return [] or Promise<[]>`)
      resolve(<any>[]) // TODO: ?
    }
  })

const run_plugins_in_fork = (
  plugins : string[],
  config : vile.YMLConfig,
  worker : any
) =>
  new Bluebird((resolve, reject) => {
    worker.on("message", (issues) => {
      if (issues) {
        worker.disconnect()
        resolve(issues)
      } else {
        worker.send(<vile.Lib.PluginWorkerData>{
          plugins: plugins,
          config: config
        })
      }
    })

    worker.on("exit", (code, signal) => {
      let name = plugins.join(",")

      _.each(plugins, (plugin : string) => {
        log.info(`${ plugin.replace("vile-", "") }:finish`)
      })

      if (signal) {
        let msg = `${name} worker was killed by signal: ${signal}`
        log.warn(msg)
        reject(msg)
      } else if (code !== 0) {
        let msg = `${name} worker exited with error code: ${code}`
        log.error(msg)
        reject(msg)
      }
    })
  })

// TODO: test this to be Windows friendly!
const normalize_paths = (issues) =>
  _.each(issues, (issue) => {
    if (_.has(issue, "path")) {
      issue.path = unixify(issue.path)
        .replace(process.cwd(), "")

      // HACK: see above todo
      if (!/windows/i.test(os.type())) {
        issue.path = unixify(issue.path)
          .replace(/^\.\/?/, "")
          .replace(/^\/?/, "")
      }
    }
  })

const check_for_uninstalled_plugins = (
  allowed : string[],
  plugins : vile.PluginList
) => {
  let errors = false

  _.each(allowed, (name : string) => {
    if (!_.some(plugins, (plugin : string) =>
      plugin.replace("vile-", "") == name
    )) {
      errors = true
      log.error(`${name} is not installed`)
    }
  })

  if (errors) process.exit(1)
}

const combine_paths = (
  combine_str : string,
  issues : vile.Issue[]
) : vile.Issue[] => {
  let combine_paths = _.map(combine_str.split(","),
                            (def : string) => def.split(":"))

  // TODO: don't be lazy with perf here- still preserve layered path changing
  _.each(combine_paths, (paths : string[]) => {
    let base = paths[0]
    let merge = paths[1]
    let base_path_ext = _.first(base.match(FILE_EXT))
    let merge_path_ext = _.first(merge.match(FILE_EXT))
    let base_path = base.replace(FILE_EXT, "")
    let merge_path = merge.replace(FILE_EXT, "")
    let merge_path_regexp = new RegExp(`^${merge_path}/`, "i")

    // TODO: Windows support, better matching
    issues.forEach((issue : vile.Issue, idx : number) =>  {
      let issue_path = unixify(_.get(issue, "path", ""))
      let issue_type = _.get(issue, "type")

      // if folder base is not same, return
      if (!merge_path_regexp.test(issue_path)) return

      // if lib.js is given, make sure .js is issue path ext
      if (!!merge_path_ext &&
          !_.first(issue_path.match(FILE_EXT)) == !!merge_path_ext) return

      let new_path = issue_path.replace(merge_path_regexp, base_path + "/")
      if (base_path_ext) {
        new_path = new_path.replace(FILE_EXT, base_path_ext)
      }

      // HACK: ugh, such perf issue below
      let potential_data_dupe : boolean = !_.some(
        util.displayable_issues,
        (t : string) => t == issue_type)
      let same_data_exists = potential_data_dupe &&
        _.some(issues, (i : vile.Issue) =>
          i && unixify(i.path) == new_path && i.type == issue_type)

      // HACK: If a lang,stat,comp issue and on base already, drop it
      if (same_data_exists) {
        issues[idx] = undefined
      } else {
        _.set(issue, "path", new_path)
      }
    })
  })

  return _.filter(issues)
}

const execute_plugins = (
  allowed : vile.PluginList = [],
  config : vile.YMLConfig = null,
  opts : any = {}
) => (plugins : string[]) : Bluebird<any> =>
  new Bluebird((resolve : any, reject) : any => {
    check_for_uninstalled_plugins(allowed, plugins)

    cluster.setupMaster({
      exec: path.join(__dirname, "plugin", "worker.js")
    })

    // TODO: own method
    if (allowed.length > 0) {
      plugins = _.filter(plugins, (p) =>
        _.some(allowed, (a) => p.replace("vile-", "") == a))
    }

    let spin
    let workers = {}
    let plugin_count : number = plugins.length
    let concurrency : number = os.cpus().length || 1

    cluster.on("fork", (worker) => {
      if (spin) spin.stop(true)
      log.info(
        `${workers[worker.id]}:start ` +
        `(${worker.id}/${plugin_count})`)
      if (spin) spin.start()
    })

    if (opts.spinner && opts.format != "json") {
      spin = new Spinner("PUNISH")
      spin.setSpinnerDelay(60)
      spin.start()
    }

    (<any>Bluebird).map(plugins, (plugin : string) => {
      let worker = cluster.fork()
      workers[worker.id] = plugin.replace("vile-", "")
      return run_plugins_in_fork([ plugin ], config, worker)
        .then((issues : vile.Issue[]) =>
          (normalize_paths(issues), issues))
        .catch((err) => {
          if (spin) spin.stop(true)
          log.error(err.stack || err)
          reject(err)
        })
    }, { concurrency: concurrency })
    .then(_.flatten)
    .then((issues : vile.Issue[]) => {
      if (spin) spin.stop(true)

      if (!_.isEmpty(opts.combine)) {
        issues = combine_paths(opts.combine, issues)
      }

      if (opts.format == "syntastic") {
        log_helper.syntastic_issues(issues)
      } else if (opts.format != "json") {
        log_helper.issues(issues)
      }

      resolve(issues)
    })
  })

const passthrough = (value : any) => value

// TODO: use Linez typings
const into_snippet = (lines : any, start : number, end : number) =>
  _.reduce(lines, (snippets, line, num) => {
    if ((num > (start - 4) && num < (end + 2))) {
      snippets.push({
        offset: _.get(line, "offset"),
        line: _.get(line, "number"),
        text: _.get(line, "text", " "),
        ending: _.get(line, "ending")
      })
    }
    return snippets
  }, [])

const add_code_snippets = () =>
  (issues : vile.IssueList) =>
    (<any>Bluebird).map(_.uniq(_.map(issues, "path")), (filepath : string) => {
      if (!(filepath &&
            fs.existsSync(filepath) &&
              fs.lstatSync(filepath).isFile())) return

      let lines = linez(fs.readFileSync(
        path.join(process.cwd(), filepath),
        "utf-8"
      )).lines

      _.each(_.filter(issues, (i : vile.Issue) => i.path == filepath),
        (issue : vile.Issue) => {
          let start = Number(_.get(issue, "where.start.line", 0))
          let end = Number(_.get(issue, "where.end.line", start))

          if (issue.type == util.DUPE) {
            let locations : vile.DuplicateLocations[] = _.
              get(issue, "duplicate.locations", [])

            _.each(locations, (loc : vile.DuplicateLocations) => {
              let start = Number(_.get(loc, "where.start.line", 0))
              let end = Number(_.get(loc, "where.end.line", start))
              if (start === 0 && end === start) return

              if (loc.path == filepath) {
                loc.snippet = into_snippet(lines, start, end)
              } else {
                // HACK: dupe reading here to get this to work with right files
                let alt_lines = linez(fs.readFileSync(
                  path.join(process.cwd(), loc.path),
                  "utf-8"
                )).lines
                loc.snippet = into_snippet(alt_lines, start, end)
              }
            })
          } else {
            if (start === 0 && end === start) return

            if (_.some(util.displayable_issues, (t) => t == issue.type)) {
              issue.snippet = into_snippet(lines, start, end)
            }
          }
        })
    })
    .then(() => issues)

const cwd_plugins_path = () =>
  path.resolve(path.join(process.cwd(), "node_modules", "@forthright"))

const add_ok_issues = (
  vile_allow : vile.AllowList = [],
  vile_ignore : vile.IgnoreList = [],
  log_distinct_ok_issues = false
) =>
  (issues : vile.IssueList) =>
    util.promise_each(
      process.cwd(),
      // TODO: don't compile ignore/allow every time
      // NOTE: need to fallthrough if is_dir, in case --gitdiff is set
      (p, is_dir) => (util.allowed(p, vile_allow) || is_dir) &&
        !util.ignored(p, vile_ignore) ,
      (filepath) => util.issue({
        type: util.OK,
        path: unixify(filepath)
      }),
      { read_data: false })
    .then((ok_issues : vile.IssueList) => {
      let distinct_ok_issues = _.reject(ok_issues, (issue : vile.Issue) =>
        _.some(issues, (i) => i.path == issue.path))

      if (log_distinct_ok_issues) {
        log_helper.issues(distinct_ok_issues)
      }

      return distinct_ok_issues.concat(issues)
    })

const run_plugins = (
  custom_plugins : vile.PluginList = [],
  config : vile.YMLConfig = {},
  opts : any = {}
) : Bluebird<vile.IssueList> => {
  let app_config = _.get(config, "vile", { plugins: [] })
  let ignore = _.get(app_config, "ignore", null)
  let allow = _.get(app_config, "allow", null)
  let plugins : vile.PluginList = custom_plugins
  let lookup_ok_issues = !opts.dontpostprocess

  if (app_config.plugins) {
    plugins = _.uniq(plugins.concat(app_config.plugins))
  }

  return (<any>fs).readdirAsync(cwd_plugins_path())
    .filter(is_plugin)
    .then(execute_plugins(plugins, config, opts))
    .then(opts.snippets ? add_code_snippets() : passthrough)
    .then(lookup_ok_issues ?
          add_ok_issues(allow, ignore, opts.scores) : passthrough)
    .catch(error_executing_plugins)
}

export = <vile.Lib.Plugin>{
  exec: run_plugins,
  exec_plugin: run_plugin
}
