import { cli } from "cli-ux"
import { green } from "chalk"
import {
  expand,
  AbapObject,
  AbapInclude,
  list,
  supportedType
} from "./lib/abap"
import {
  ADTClient,
  session_types,
  AdtLock,
  inactiveObjectsInResults
} from "abap-adt-api"
import { ABAPLINT_DEFAULT, ListOptions } from "./lib/common"
import {
  loadAbapLintConfig,
  abapLintprettyPrint
} from "./lib/abaplintprettyprint"
import chalk = require("chalk")
import { readFileSync } from "fs"
const tick = green("\u2713")

export interface Options {
  test: boolean
  transport?: string
}
interface Status {
  currentObject?: AbapObject
  currentInclude?: AbapInclude
  processedObjects: number
  processedIncludes: number
  writtenIncludes: number
}
export class Main {
  // eslint-disable-next-line no-useless-constructor
  constructor(private client: ADTClient, public abapLint?: string) {}

  private readonly status: Status = {
    processedIncludes: 0,
    processedObjects: 0,
    writtenIncludes: 0
  }

  private async tryLock(url: string) {
    try {
      return await this.client.lock(url)
    } catch (error) {
      if (
        error?.type === "ExceptionResourceNoAccess" &&
        !error?.message.match(/locked/i)
      )
        return
      throw error
    }
  }

  private validateTransport(lock: AdtLock, key: string, transport?: string) {
    if (lock.IS_LOCAL && transport)
      cli.error(`Object ${key} is local, can't use ${transport}`)

    if (!lock.IS_LOCAL && !transport)
      cli.error(
        `Object ${key} requires a transport ${
          lock.CORRNR ? `(locked in ${lock.CORRNR})` : ""
        }`
      )

    if (transport !== lock.CORRNR && !lock.IS_LOCAL && lock.CORRNR)
      cli.error(
        `Object ${key} locked in transport ${lock.CORRNR} can't use ${transport}`
      )
  }

  private async activate(incl: AbapInclude) {
    if (incl.type === "PROG/I") {
      const main = await this.client.statelessClone.mainPrograms(incl.metaUrl)
      return this.client.activate(
        incl.name,
        incl.sourceUrl,
        main?.[0]["adtcore:uri"]
      )
    }
    const active = await this.client.activate(incl.name, incl.sourceUrl)
    if (active.inactive.length > 0) {
      const inactives = inactiveObjectsInResults(active)
      return this.client.activate(inactives)
    }
    return active
  }

  private async write(
    incl: AbapInclude,
    formatted: string,
    lock: AdtLock,
    { test, transport }: Options
  ) {
    const key = `${incl.type} ${incl.name}`
    if (!lock.LOCK_HANDLE) cli.error(`Failed to lock ${key}`)
    this.validateTransport(lock, key, transport)
    cli.action.start(`\t${key}`, ` Writing...`)
    if (!test)
      await this.client.setObjectSource(
        incl.sourceUrl,
        formatted,
        lock.LOCK_HANDLE,
        transport
      )
    cli.action.start(`\t${key}`, ` Unlocking...`)
    await this.client.unLock(incl.sourceUrl, lock.LOCK_HANDLE)
    cli.action.start(`\t${key}`, ` Activating...`)
    if (!test) {
      const active = await this.activate(incl)
      if (active.success === false)
        cli.error(active.messages[0]?.shortText || `Failed to activate ${key}`)
    }
    cli.action.start(`\t${tick}${key}`)
    this.status.writtenIncludes++
  }

  private format(incl: AbapInclude, source: string) {
    if (this.abapLint) return abapLintprettyPrint(incl, source)
    return this.client.statelessClone.prettyPrinter(source)
  }

  private async processInclude(incl: AbapInclude, options: Options) {
    this.status.currentInclude = incl
    const key = `${incl.type} ${incl.name}`
    cli.action.start(`\t${key}`, ` Reading...`)
    const source = await this.client.statelessClone.getObjectSource(
      incl.sourceUrl
    )
    cli.action.start(`\t${key}`, ` Formatting...`)
    const formatted = await this.format(incl, source)
    if (formatted === source) cli.action.start(`\t${tick}${key} (unchanged)`)
    else {
      cli.action.start(`\t${key}`, ` Locking...`)
      const lock = await this.tryLock(incl.sourceUrl)
      if (lock) {
        await this.write(incl, formatted, lock, options)
      } else cli.action.start(`\t${tick}${key} is generated, skipped`)
    }

    cli.action.stop()
    this.status.processedIncludes++
    this.status.currentInclude = undefined
  }

  private stats(objnum: number) {
    const msg = `\n${this.status.processedObjects} of ${objnum} objects / ${this.status.processedIncludes} includes processed ${this.status.writtenIncludes} written\n`
    cli.log(chalk.bold(msg))
  }

  public async processObjects(objects: AbapObject[], options: Options) {
    if (this.abapLint && this.abapLint !== ABAPLINT_DEFAULT)
      await loadAbapLintConfig(this.abapLint)
    this.client.stateful = session_types.stateful
    try {
      for (const o of objects) {
        this.status.currentObject = o
        cli.action.start(`${o.type} ${o.name}`)
        const includes = await expand(this.client, o)
        cli.action.start(`${tick}${o.type} ${o.name}`)
        cli.action.stop()
        for (const incl of includes) await this.processInclude(incl, options)
        this.status.processedObjects++
      }
    } catch (error) {
      cli.action.stop("failed!")
      const { currentInclude, currentObject } = this.status
      cli.log(`Last object ${currentObject?.type} ${currentObject?.name}`)
      if (currentInclude)
        cli.log(`Last include ${currentInclude.type} ${currentInclude.name}`)
      throw error
    } finally {
      this.stats(objects.length)
      this.client.stateful = session_types.stateless
      await this.client.dropSession()
    }
  }

  public async list(type: string, name: string, options: ListOptions) {
    const { file, recursive } = options
    if ((name || type) && file)
      cli.error(
        "Can't specify an object name or type and a list file at the same time"
      )

    if (file) {
      const isHeader = (l: string, i: number) => {
        return i === 0 && !l.match(/\//)
      }
      const objects = readFileSync(file)
        .toString()
        .split("\n")
        .filter((l, i) => l && !isHeader(l, i))
        .map(x => x.split(/\s+/, 3))
        .map(([type, name, url], i) => {
          if (!supportedType(type))
            cli.error(
              `Objects of type ${type} are not supportes near line ${i} of file ${file}`
            )
          if (!url)
            cli.error(
              `URL not specified for object ${type} ${name} in file ${file}`
            )
          return { type, name, url }
        })

      return objects
    }

    if (!name || !type)
      cli.error(`Object type and name required unless a list file is provided`)
    const objects = await list(
      this.client,
      type,
      name,
      message => cli.action.start(message),
      recursive
    )
    cli.action.stop("Done")
    return objects
  }
}
