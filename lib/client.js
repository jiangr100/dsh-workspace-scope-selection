// dsh-workspace-scope-selection — web client half (module-loader bundle).
//
// This file is the package's prebuilt client bundle: it registers one module
// with the web shell's module loader (window.__ModuleLoader__) and exports a
// Cordis client plugin. It requires only `react`; everything else comes from
// client services (`slots`, `connection`, `remote`, `sessions`).
//
// What it contributes: the fourth permission option "Selected Workspace
// Write" appears automatically in the composer permission chip and the
// /permission popup, because the host plugin advertises it in the preset
// table (the projection derives options from that table). This client half
// adds the SCOPE EDITOR for that option: when a session runs under
// selected-workspace-write, a dock bar above the composer shows the current
// selection and opens a directory-tree picker rooted at the session's
// workspace. Walking the tree (breadcrumbs up to the filesystem root) and
// toggling directories writes the selection through the host's
// `/workspace-scope set` command; the `workspace-scope` session projection
// pushes the resulting state back, so the bar and the tree stay in sync with
// the server.
//
// Directory listings come from the host's `host.listDirectory` RPC (the
// browse capability) when the composition serves it; when the composition
// serves the native picker instead, the tree falls back to the plugin's own
// `/workspace-scope list` host command.

window.__ModuleLoader__.load({
  id: 'dsh-workspace-scope-selection',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    // ---------- copy ----------
    var LANG = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '') ? 'zh' : 'en'
    function L(zh, en) {
      return LANG === 'zh' ? zh : en
    }

    var MODE = 'selected-workspace-write'

    // ---------- styling (cosmetic; never fail the plugin) ----------
    var CSS = [
      '.wss-dock { box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform); border-radius: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.wss-dockLabel { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }',
      '.wss-dockCount { color: var(--dsw-alias-label-caption); white-space: nowrap; }',
      '.wss-dockBtn { border: none; border-radius: 8px; padding: 3px 10px; font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); white-space: nowrap; }',
      '.wss-dockBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
      '.wss-dockBtn:disabled { opacity: .55; cursor: default; }',
      '.wss-overlay { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }',
      '.wss-modal { box-sizing: border-box; width: min(560px, calc(100vw - 48px)); max-height: min(640px, calc(100vh - 96px)); display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--dsw-alias-border-inverted); background: var(--dsw-specific-menu); box-shadow: var(--dsw-shadow-lv3); border-radius: 14px; padding: 14px; color: var(--dsw-alias-label-primary); }',
      '.wss-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '.wss-title { font-size: 14px; font-weight: 600; line-height: 20px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.wss-close { display: inline-flex; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 2px; border-radius: 6px; }',
      '.wss-close:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.wss-caption { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }',
      '.wss-crumbs { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; font-size: 12px; line-height: 18px; }',
      '.wss-crumb { border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 1px 4px; border-radius: 6px; font: inherit; }',
      '.wss-crumb:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.wss-crumbSep { color: var(--dsw-alias-label-caption); }',
      '.wss-tree { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 120px; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }',
      '.wss-row { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: none; background: transparent; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 8px; cursor: pointer; font: inherit; }',
      '.wss-row:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.wss-rowName { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.wss-rowNameDim { opacity: .55; }',
      '.wss-check { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 5px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: #fff; cursor: pointer; padding: 0; }',
      '.wss-check:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary); }',
      '.wss-checkOn { background: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }',
      '.wss-check:disabled { cursor: default; opacity: .6; }',
      '.wss-hint { color: var(--dsw-alias-label-caption); font-size: 10px; line-height: 14px; white-space: nowrap; }',
      '.wss-chevron { flex: none; display: inline-flex; color: var(--dsw-alias-label-caption); }',
      '.wss-foot { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 10px; }',
      '.wss-footRoots { min-width: 0; flex: 1; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.wss-btn { border: none; border-radius: 8px; padding: 4px 12px; font: inherit; font-size: 12px; line-height: 20px; cursor: pointer; white-space: nowrap; }',
      '.wss-btn:disabled { opacity: .5; cursor: default; }',
      '.wss-btnGhost { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.wss-btnPrimary { background: var(--dsw-alias-button-info-fill); color: #fff; }',
      '.wss-btnDanger { background: transparent; color: var(--dsw-alias-state-error-primary); }',
      '.wss-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; }',
      '.wss-busy { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }',
      '.wss-empty { color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 1.5; padding: 8px; }',
    ].join('\n')

    // ---------- icons ----------
    function IconFolder() {
      return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('path', { d: 'M2 3.5h4l1.5 2H14v7H2v-9Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
      )
    }
    function IconChevron() {
      return React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
        React.createElement('path', { d: 'M3 4.5L6 7.5L9 4.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }
    function IconCheck() {
      return React.createElement('svg', { width: 10, height: 10, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
        React.createElement('path', { d: 'M2.5 6.5L5 9L9.5 3.5', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }
    function IconClose() {
      return React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
        React.createElement('path', { d: 'M3 3L9 9M9 3L3 9', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }
    function IconScope() {
      return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('path', { d: 'M8 1.5L14.5 4V8.5C14.5 12 11.6 14.2 8 15C4.4 14.2 1.5 12 1.5 8.5V4L8 1.5Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        React.createElement('path', { d: 'M8 8.5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0', stroke: 'currentColor', strokeWidth: 1.1 }),
      )
    }

    // ---------- shared helpers ----------
    function sepOf(path) {
      return path.indexOf('\\') !== -1 ? '\\' : '/'
    }
    // Whether `path` is `root` or lies beneath it (separator-aware prefix).
    function isUnder(path, root) {
      if (path === root) return true
      var sep = sepOf(root)
      var prefix = root.endsWith(sep) ? root : root + sep
      return path.indexOf(prefix) === 0
    }
    // The deepest selected root that covers `path`, or undefined.
    function coveringRoot(path, roots) {
      var best = undefined
      for (var i = 0; i < roots.length; i++) {
        var root = roots[i]
        if (isUnder(path, root) && (best === undefined || root.length > best.length)) best = root
      }
      return best
    }

    function apply(ctx) {
      var styleTag = null
      try {
        styleTag = document.createElement('style')
        styleTag.textContent = CSS
        document.head.appendChild(styleTag)
      } catch (err) { /* styling is cosmetic */ }

      function connection() {
        var value = ctx.get('connection')
        return value !== undefined && value !== null ? value : undefined
      }
      function remote() {
        var value = ctx.get('remote')
        return value !== undefined && value !== null ? value : undefined
      }
      function api() {
        var conn = connection()
        return conn !== undefined && conn.api !== undefined ? conn.api : undefined
      }

      // Execute one slash-command and return { ok, result } where result is
      // the normalized { kind, text } command result when the host answered.
      async function runCommand(sessionId, line) {
        var rem = remote()
        if (rem === undefined || typeof rem.commands === 'undefined' || typeof rem.commands.execute !== 'function') {
          return { ok: false, error: 'remote command service unavailable' }
        }
        try {
          var response = await rem.commands.execute(sessionId, line)
          if (response === undefined || response === null || response.ok !== true) {
            var message = response !== undefined && response !== null && response.error !== undefined && response.error.message !== undefined
              ? response.error.message
              : 'command failed'
            return { ok: false, error: message }
          }
          var result = response.value !== undefined && response.value !== null ? response.value.result : undefined
          if (result === undefined || result.kind !== 'success') {
            return { ok: false, error: result !== undefined && result.text !== undefined ? result.text : 'command failed' }
          }
          return { ok: true, result: result }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      // List one directory level. Primary: host.listDirectory (browse
      // capability). Fallback: the plugin's own /workspace-scope list
      // command, used when the composition serves the native picker.
      async function listLevel(sessionId, path) {
        var face = api()
        if (face !== undefined && face.host !== undefined && typeof face.host.listDirectory === 'function') {
          try {
            var response = await face.host.listDirectory({ path: path })
            if (response !== undefined && response.result !== undefined && response.result.ok === true) {
              return { ok: true, value: response.result.value, source: 'browse' }
            }
            if (response !== undefined && response.result !== undefined && response.result.error !== undefined) {
              var code = response.result.error.code
              if (code === 'directory-picker-unavailable') {
                return fallbackList(sessionId, path)
              }
              return { ok: false, error: response.result.error.message }
            }
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        }
        return fallbackList(sessionId, path)
      }

      async function fallbackList(sessionId, path) {
        var outcome = await runCommand(sessionId, '/workspace-scope list ' + path)
        if (!outcome.ok) return { ok: false, error: outcome.error }
        try {
          return { ok: true, value: JSON.parse(outcome.result.text), source: 'command' }
        } catch (err) {
          return { ok: false, error: 'workspace-scope: host returned an invalid listing' }
        }
      }

      // ---------- the scope editor (modal with the directory tree) ----------
      function ScopeEditor(props) {
        // props: sessionId, workspaceRoot (injected, may be undefined), roots, onClose
        var state = React.useState({
          root: props.workspaceRoot !== undefined ? props.workspaceRoot : null,
          path: null,
          listing: null, // { path, crumbs, entries, truncated }
          loading: false,
          saving: false,
          error: null,
          source: null, // 'browse' | 'command'
        })
        var snap = state[0]
        var setSnap = state[1]
        var patch = function (part) { setSnap(function (prev) { return Object.assign({}, prev, part) }) }

        // Resolve the root when the injected workspace root is absent (the
        // session list may not have carried cwd) via /workspace-scope info.
        React.useEffect(function () {
          var cancelled = false
          ;(async function () {
            if (snap.root !== null) return
            var outcome = await runCommand(props.sessionId, '/workspace-scope info')
            if (cancelled) return
            if (!outcome.ok) {
              patch({ error: outcome.error })
              return
            }
            var info = null
            try { info = JSON.parse(outcome.result.text) } catch (err) { /* invalid */ }
            var root = info !== null && typeof info.workspaceRoot === 'string' && info.workspaceRoot !== '' ? info.workspaceRoot : null
            patch({ root: root, error: root === null ? L('无法解析工作区根目录', 'could not resolve the workspace root') : null })
          })()
          return function () { cancelled = true }
        }, [snap.root])

        // Load the first level when the root is known.
        React.useEffect(function () {
          var cancelled = false
          if (snap.root === null || snap.path !== null) return
          ;(async function () {
            patch({ loading: true, error: null })
            var outcome = await listLevel(props.sessionId, snap.root)
            if (cancelled) return
            if (!outcome.ok) {
              patch({ loading: false, error: outcome.error })
              return
            }
            patch({ loading: false, path: outcome.value.path, listing: outcome.value, source: outcome.source })
          })()
          return function () { cancelled = true }
        }, [snap.root, snap.path])

        // Navigate into a directory.
        function enter(path) {
          patch({ loading: true, error: null })
          listLevel(props.sessionId, path).then(function (outcome) {
            if (!outcome.ok) {
              patch({ loading: false, error: outcome.error })
              return
            }
            patch({ loading: false, path: outcome.value.path, listing: outcome.value, source: outcome.source })
          })
        }

        // Persist one whole selection.
        function save(roots) {
          patch({ saving: true, error: null })
          runCommand(props.sessionId, '/workspace-scope set ' + JSON.stringify(roots)).then(function (outcome) {
            if (!outcome.ok) {
              patch({ saving: false, error: outcome.error })
              return
            }
            patch({ saving: false })
          })
        }

        // Toggle one directory: exact-root semantics. A row that is only
        // COVERED by a selected ancestor is not toggleable here — uncheck
        // the ancestor (its row shows the covering check) to stop including
        // the whole subtree.
        function toggle(path) {
          if (snap.saving) return
          var self = props.roots.indexOf(path)
          var next
          if (self !== -1) {
            next = props.roots.filter(function (root) { return root !== path })
          } else {
            next = props.roots.concat([path])
          }
          save(next)
        }

        // Escape / outside-click closes the modal.
        var modalRef = React.useRef(null)
        React.useEffect(function () {
          function onDown(ev) {
            if (modalRef.current !== null && ev.target instanceof Node && modalRef.current.contains(ev.target)) return
            props.onClose()
          }
          function onKey(ev) {
            if (ev.key !== 'Escape') return
            ev.preventDefault()
            ev.stopPropagation()
            props.onClose()
          }
          document.addEventListener('pointerdown', onDown, true)
          document.addEventListener('keydown', onKey, true)
          return function () {
            document.removeEventListener('pointerdown', onDown, true)
            document.removeEventListener('keydown', onKey, true)
          }
        }, [])

        var listing = snap.listing
        var crumbs = listing !== null ? listing.crumbs : []
        var entries = listing !== null ? listing.entries : []
        return React.createElement('div', { className: 'wss-overlay' },
          React.createElement('div', { className: 'wss-modal', ref: modalRef, role: 'dialog', 'aria-label': L('选择可写目录', 'Select writable directories') },
            React.createElement('div', { className: 'wss-head' },
              React.createElement('span', { className: 'wss-title' }, L('可写目录范围', 'Writable directory scope')),
              React.createElement('button', { type: 'button', className: 'wss-close', onClick: props.onClose, 'aria-label': L('关闭', 'Close') }, IconClose()),
            ),
            React.createElement('div', { className: 'wss-caption' },
              L('勾选的目录及其子目录允许 agent 写入，工作区本身始终可写。取消勾选父目录会移除整棵子树。', 'Checked directories and everything beneath them are writable by the agent; the workspace itself is always writable. Unchecking a parent removes its whole subtree.'),
            ),
            snap.error !== null && React.createElement('div', { className: 'wss-error' }, snap.error),
            snap.root !== null && React.createElement('div', { className: 'wss-crumbs' },
              crumbs.map(function (crumb, index) {
                return React.createElement(React.Fragment, { key: crumb.path },
                  index > 0 && React.createElement('span', { className: 'wss-crumbSep' }, '/'),
                  React.createElement('button', {
                    type: 'button',
                    className: 'wss-crumb',
                    title: crumb.path,
                    onClick: function () {
                      if (crumb.path !== snap.path) enter(crumb.path)
                    },
                  }, crumb.name),
                )
              }),
            ),
            React.createElement('div', { className: 'wss-tree' },
              snap.loading && React.createElement('div', { className: 'wss-busy' }, L('加载中…', 'Loading…')),
              !snap.loading && snap.path !== null && React.createElement('div', { className: 'wss-row' },
                React.createElement('button', {
                  type: 'button',
                  className: 'wss-check' + (coveringRoot(snap.path, props.roots) !== undefined ? ' wss-checkOn' : ''),
                  disabled: snap.saving || (coveringRoot(snap.path, props.roots) !== undefined && props.roots.indexOf(snap.path) === -1),
                  'aria-label': L('切换当前目录', 'Toggle this directory'),
                  title: L('当前目录', 'This directory'),
                  onClick: function (ev) { ev.stopPropagation(); toggle(snap.path) },
                }, coveringRoot(snap.path, props.roots) !== undefined ? IconCheck() : null),
                React.createElement('span', { className: 'wss-rowName' },
                  IconFolder(),
                  React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, snap.path),
                ),
                coveringRoot(snap.path, props.roots) !== undefined && props.roots.indexOf(snap.path) === -1 &&
                  React.createElement('span', { className: 'wss-hint' }, L('经父目录包含', 'via parent')),
              ),
              !snap.loading && snap.path !== null && entries.map(function (entry) {
                var covered = coveringRoot(entry.path, props.roots)
                var self = props.roots.indexOf(entry.path) !== -1
                var on = covered !== undefined
                return React.createElement('div', {
                  key: entry.path,
                  className: 'wss-row',
                  onClick: function () { enter(entry.path) },
                },
                  React.createElement('button', {
                    type: 'button',
                    className: 'wss-check' + (on ? ' wss-checkOn' : ''),
                    disabled: snap.saving || (on && !self),
                    'aria-label': L('切换目录', 'Toggle directory') + ' ' + entry.path,
                    title: on && !self ? L('经父目录包含：取消父目录后整个子树将不再可写', 'Included via a parent directory; uncheck the parent to remove its whole subtree') : entry.path,
                    onClick: function (ev) { ev.stopPropagation(); toggle(entry.path) },
                  }, on ? IconCheck() : null),
                  React.createElement('span', { className: 'wss-rowName' + (entry.hidden ? ' wss-rowNameDim' : '') },
                    IconFolder(),
                    React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
                  ),
                  on && !self && React.createElement('span', { className: 'wss-hint' }, L('经父目录', 'via parent')),
                  React.createElement('span', { className: 'wss-chevron' }, IconChevron()),
                )
              }),
              !snap.loading && snap.path !== null && entries.length === 0 &&
                React.createElement('div', { className: 'wss-empty' }, L('（无子目录）', '(no subdirectories)')),
            ),
            React.createElement('div', { className: 'wss-foot' },
              React.createElement('span', { className: 'wss-footRoots', title: props.roots.join('\n') },
                props.roots.length === 0
                  ? L('未选择额外目录 — 仅工作区可写', 'No extra directories selected — only the workspace is writable')
                  : L('已选择 ' + props.roots.length + ' 个目录', String(props.roots.length) + ' director' + (props.roots.length === 1 ? 'y' : 'ies') + ' selected'),
              ),
              React.createElement('button', {
                type: 'button',
                className: 'wss-btn wss-btnDanger',
                disabled: snap.saving || props.roots.length === 0,
                onClick: function () { save([]) },
              }, L('清除全部', 'Clear all')),
              React.createElement('button', {
                type: 'button',
                className: 'wss-btn wss-btnPrimary',
                disabled: snap.saving,
                onClick: props.onClose,
              }, L('完成', 'Done')),
            ),
            snap.saving && React.createElement('div', { className: 'wss-busy' }, L('保存中…', 'Saving…')),
          ),
        )
      }

      // ---------- the dock bar (above the composer) ----------
      function ScopeDock(props) {
        // props: useProjection, sessionId, workspaceRoot (injected)
        var permissions = props.useProjection('permissions')
        var scope = props.useProjection('workspace-scope')
        var openState = React.useState(false)
        var open = openState[0]
        var setOpen = openState[1]
        var active = permissions !== undefined && permissions.currentValue === MODE
        React.useEffect(function () {
          if (!active) setOpen(false)
        }, [active])
        if (!active) return null
        var roots = scope !== undefined && Array.isArray(scope.roots) ? scope.roots : []
        var label = roots.length === 0
          ? L('Selected workspace write — 仅工作区可写', 'Selected workspace write — workspace only')
          : L('Selected workspace write — 已选择 ' + String(roots.length) + ' 个目录', 'Selected workspace write — ' + String(roots.length) + ' director' + (roots.length === 1 ? 'y' : 'ies') + ' selected')
        return React.createElement('div', { className: 'wss-dock', 'data-workspace-scope-dock': true },
          React.createElement('span', { className: 'wss-dockLabel', title: roots.length > 0 ? roots.join('\n') : undefined },
            React.createElement('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-state-business-primary)' } }, IconScope()),
            React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
          ),
          React.createElement('button', {
            type: 'button',
            className: 'wss-dockBtn',
            onClick: function () { setOpen(true) },
          }, L('编辑范围', 'Edit scope')),
          open && React.createElement(ScopeEditor, {
            sessionId: props.sessionId,
            workspaceRoot: props.workspaceRoot,
            roots: roots,
            onClose: function () { setOpen(false) },
          }),
        )
      }

      // ---------- registration ----------
      var disposers = []
      var slots = ctx.get('slots')
      if (slots !== undefined) {
        disposers.push(ctx.effect(function () {
          return slots.inject('conversation.input.dock', function () {
            return slots.register({
              name: 'conversation.input.dock',
              id: 'workspace-scope',
              order: 30,
              inject: function (sessionId) {
                // The session's workspace root never changes; the list
                // snapshot is the cheapest reliable source (the host editor
                // falls back to /workspace-scope info when it is absent).
                var root = undefined
                try {
                  var sessions = ctx.get('sessions')
                  if (sessions !== undefined && typeof sessions.getListSnapshot === 'function') {
                    var items = sessions.getListSnapshot().items
                    for (var i = 0; i < items.length; i++) {
                      if (items[i].sessionId === sessionId && items[i].cwd !== undefined) {
                        root = items[i].cwd
                        break
                      }
                    }
                  }
                } catch (err) { /* non-fatal: the editor resolves the root itself */ }
                return { workspaceRoot: root }
              },
            }, ScopeDock)
          })
        }))
      }

      return function () {
        for (var i = 0; i < disposers.length; i++) {
          try { disposers[i]() } catch (err) { /* best effort */ }
        }
        if (styleTag !== null && styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag)
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection', 'remote', 'sessions']
    return module.exports
  },
})
