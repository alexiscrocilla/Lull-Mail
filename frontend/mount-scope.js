// SPDX-License-Identifier: GPL-3.0-or-later
// @ts-check

/** @typedef {() => void} Disposer */

/**
 * Owns every disposable resource created while a SPA route is mounted.
 * Disposal is idempotent and runs in reverse registration order.
 */
export class MountScope {
  constructor() {
    /** @type {Disposer[]} */
    this._disposers = [];
    this.disposed = false;
  }

  /** @param {Disposer} disposer @returns {Disposer} */
  add(disposer) {
    if (this.disposed) {
      try { disposer(); } catch (_) { }
      return () => {};
    }
    let active = true;
    const wrapped = () => {
      if (!active) return;
      active = false;
      disposer();
    };
    this._disposers.push(wrapped);
    return wrapped;
  }

  /**
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} listener
   * @param {boolean|AddEventListenerOptions} [options]
   * @returns {Disposer}
   */
  listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    return this.add(() => target.removeEventListener(type, listener, options));
  }

  /** @param {() => void} callback @param {number} delayMs @returns {number} */
  timeout(callback, delayMs) {
    const id = window.setTimeout(callback, delayMs);
    this.add(() => window.clearTimeout(id));
    return id;
  }

  /** @param {() => void} callback @param {number} delayMs @returns {number} */
  interval(callback, delayMs) {
    const id = window.setInterval(callback, delayMs);
    this.add(() => window.clearInterval(id));
    return id;
  }

  /** @returns {AbortController} */
  controller() {
    const controller = new AbortController();
    this.add(() => controller.abort());
    return controller;
  }

  /** @template {ResizeObserver|IntersectionObserver|MutationObserver} T @param {T} observer @returns {T} */
  observer(observer) {
    this.add(() => observer.disconnect());
    return observer;
  }

  /** @param {Animation} animation @returns {Animation} */
  animation(animation) {
    this.add(() => animation.cancel());
    return animation;
  }

  /** @returns {MountScope} */
  child() {
    const scope = new MountScope();
    this.add(() => scope.dispose());
    return scope;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const disposers = this._disposers.splice(0).reverse();
    for (const dispose of disposers) {
      try { dispose(); } catch (_) { }
    }
  }
}
