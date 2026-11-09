/**
 * No modo PC não há Redis: este é um substituto em memória, com só o que o
 * JARVIS usa (contadores com validade, chaves com validade e pub/sub entre
 * partes do mesmo processo). Tudo que precisa sobreviver a um reinício fica
 * no banco, não aqui.
 */
import { EventEmitter } from 'node:events'

const chaves = new Map() // chave -> { v, ate }
const canais = new EventEmitter()
canais.setMaxListeners(1000)

function viva(k) {
  const e = chaves.get(k)
  if (!e) return null
  if (e.ate && e.ate < Date.now()) {
    chaves.delete(k)
    return null
  }
  return e
}

export class RedisMemoria extends EventEmitter {
  #inscritos = new Map()
  status = 'ready'
  async ping() {
    return 'PONG'
  }
  async incr(k) {
    const e = viva(k) ?? { v: 0, ate: 0 }
    e.v = Number(e.v) + 1
    chaves.set(k, e)
    return e.v
  }
  async expire(k, seg) {
    const e = viva(k)
    if (e) e.ate = Date.now() + seg * 1000
    return e ? 1 : 0
  }
  async set(k, v, modo, seg) {
    chaves.set(k, { v, ate: modo === 'EX' ? Date.now() + seg * 1000 : 0 })
    return 'OK'
  }
  async get(k) {
    return viva(k)?.v ?? null
  }
  async exists(k) {
    return viva(k) ? 1 : 0
  }
  async del(k) {
    return chaves.delete(k) ? 1 : 0
  }
  async publish(canal, msg) {
    canais.emit(canal, canal, msg)
    return canais.listenerCount(canal)
  }
  async subscribe(canal) {
    if (this.#inscritos.has(canal)) return
    const fn = (c, m) => this.emit('message', c, m)
    this.#inscritos.set(canal, fn)
    canais.on(canal, fn)
  }
  disconnect() {
    for (const [c, fn] of this.#inscritos) canais.off(c, fn)
    this.#inscritos.clear()
    this.status = 'end'
  }
  async quit() {
    this.disconnect()
    return 'OK'
  }
}
