/* MedBuddy — fluid bottom sheets, Apple-style.
   Motion always starts from wherever the panel currently is on screen,
   never from a fixed "target" value — so a drag can grab an in-flight
   open/close animation and reverse it at any instant, with no jump.
   Opening, dragging, snapping back, and dismissing all run through the
   same spring integrator, so the exit always retraces the entrance. */

(function () {
  function reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* Apple's damping-ratio + response(seconds) model, converted to
     stiffness/damping for a mass=1 spring: omega0 = 2*PI / response,
     stiffness = omega0^2, damping = 2 * dampingRatio * omega0. */
  function springParams(dampingRatio, response) {
    const omega0 = (2 * Math.PI) / response;
    return { stiffness: omega0 * omega0, damping: 2 * dampingRatio * omega0 };
  }
  const SNAP_BACK = springParams(0.8, 0.3); // Apple's drawer/sheet preset
  const DISMISS = springParams(1.0, 0.3); // exiting — no bounce needed

  /* Progressive resistance past a boundary, so an overscroll drag slows
     continuously instead of hard-stopping. */
  function rubberband(overshoot, dimension, constant = 0.55) {
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
  }

  function Sheet(rootEl, panelEl, handleEl, onDismissed) {
    this.root = rootEl;
    this.panel = panelEl;
    this.handle = handleEl;
    this.onDismissed = onDismissed;
    this.y = 0; // current translateY in px; 0 = fully open
    this.velocity = 0; // px/s, positive = moving down
    this.raf = null;
    this.history = [];
    this._move = this.onPointerMove.bind(this);
    this._up = this.onPointerUp.bind(this);

    if (handleEl) {
      handleEl.addEventListener('pointerdown', this.onPointerDown.bind(this));
    }
  }

  Sheet.prototype.restHeight = function () {
    return this.panel.getBoundingClientRect().height || window.innerHeight * 0.6;
  };

  Sheet.prototype.setFrame = function (y) {
    this.y = y;
    this.panel.style.transform = y === 0 ? 'none' : 'translateY(' + y + 'px)';
    const h = this.restHeight();
    this.root.style.opacity = String(Math.max(0.15, Math.min(1, 1 - y / h)));
  };

  Sheet.prototype.open = function () {
    cancelAnimationFrame(this.raf);
    this.root.hidden = false;
    if (reducedMotion()) {
      this.setFrame(0);
      return;
    }
    const startY = this.restHeight();
    this.setFrame(startY);
    // Let the browser register the starting frame before animating away from it.
    requestAnimationFrame(() => this.animateTo(0, SNAP_BACK, 0));
  };

  Sheet.prototype.onPointerDown = function (e) {
    this.handle.setPointerCapture(e.pointerId);
    cancelAnimationFrame(this.raf); // grab mid-flight: continue from the live value, no jump
    this.pointerId = e.pointerId;
    this.startPointerY = e.clientY;
    this.startY = this.y;
    this.history = [{ y: this.y, t: performance.now() }];
    this.handle.addEventListener('pointermove', this._move);
    this.handle.addEventListener('pointerup', this._up);
    this.handle.addEventListener('pointercancel', this._up);
  };

  Sheet.prototype.onPointerMove = function (e) {
    const delta = e.clientY - this.startPointerY;
    let y = this.startY + delta;
    if (y < 0) y = -rubberband(-y, this.restHeight()); // resist dragging past fully-open
    this.setFrame(y);
    this.history.push({ y, t: performance.now() });
    if (this.history.length > 5) this.history.shift();
  };

  Sheet.prototype.onPointerUp = function () {
    this.handle.removeEventListener('pointermove', this._move);
    this.handle.removeEventListener('pointerup', this._up);
    this.handle.removeEventListener('pointercancel', this._up);

    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    const dt = Math.max(last.t - first.t, 1) / 1000;
    const velocity = (last.y - first.y) / dt; // px/s

    const height = this.restHeight();
    // Decide by velocity, not just position — a fast flick dismisses even
    // from a short drag; a slow drag needs to cross further to commit.
    const shouldDismiss = this.y > height * 0.28 || velocity > 600;

    if (shouldDismiss) {
      this.animateTo(height + 60, DISMISS, velocity, () => this.finishDismiss());
    } else {
      this.animateTo(0, SNAP_BACK, velocity);
    }
  };

  Sheet.prototype.animateTo = function (target, params, initialVelocity, onDone) {
    if (reducedMotion()) {
      this.setFrame(target);
      if (onDone) onDone();
      return;
    }
    cancelAnimationFrame(this.raf);
    let position = this.y;
    let velocity = initialVelocity;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const accel = -params.stiffness * (position - target) - params.damping * velocity;
      velocity += accel * dt;
      position += velocity * dt;
      this.setFrame(position);

      const settled = Math.abs(position - target) < 0.5 && Math.abs(velocity) < 20;
      if (!settled) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.setFrame(target);
        if (onDone) onDone();
      }
    };
    this.raf = requestAnimationFrame(step);
  };

  Sheet.prototype.finishDismiss = function () {
    this.root.hidden = true;
    this.panel.style.transform = '';
    this.root.style.opacity = '';
    this.y = 0;
    this.velocity = 0;
    if (this.onDismissed) this.onDismissed();
  };

  Sheet.prototype.dismiss = function () {
    // Programmatic close (X button, backdrop tap, Escape) retraces the
    // same path a drag-dismiss would take, just starting from rest.
    if (this.root.hidden) return;
    cancelAnimationFrame(this.raf);
    this.animateTo(this.restHeight() + 60, DISMISS, Math.max(this.velocity, 500), () =>
      this.finishDismiss()
    );
  };

  window.SheetController = Sheet;
})();
