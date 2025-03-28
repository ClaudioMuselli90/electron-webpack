import Crocket from "crocket"
import { Stats } from "webpack"

const debug = require("debug")("electron-webpack:dev-runner")

export class HmrServer {
  private state = false
  readonly ipc = new Crocket()

  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      const socketPath = `/tmp/electron-main-ipc-${process.pid.toString(16)}.sock`
      this.ipc.listen({path: socketPath}, error => {
        if (error != null) {
          reject(error)
        }
        if (debug.enabled) {
          debug(`HMR Server listening on ${socketPath}`)
        }
        resolve(socketPath)
      })
    })
  }

  beforeCompile() {
    this.state = false
  }

  built(stats: Stats | undefined): void {
    this.state = true
    setImmediate(() => {
      if (!this.state) {
        return
      }

      if (stats) {
        const hash = stats.toJson({assets: false, chunks: false, children: false, modules: false}).hash
        if (debug.enabled) {
          debug(`Send built: hash ${hash}`)
        }
        this.ipc.emit("/built", {hash})
      }
    })
  }
}