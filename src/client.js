/**
 * dsh-cosplay — 浏览器侧（dsh.client 声明，包入口 dsh-cosplay/client）。
 *
 * 设置页新增「角色扮演」页（settings.section 列表条目），承载：
 *   - 全局开关（enabled）；
 *   - 角色库管理：列表 / 激活 / 新建 / 编辑 / 删除；
 *   - 角色卡字段：name / emoji / description / style / rules / greeting / sample。
 *
 * 数据通道：0.1.2-rc.1 起第三方 settings 命名空间不再受白名单限制，设置页直接
 * 走标准 `ctx.remote.settings` 远程命名空间：
 *   - 读：`remote.settings.describe()` → 找 `cosplay` 命名空间的 value/revision；
 *   - 写：`remote.settings.replace('cosplay', nextSection, revision)` 整体替换。
 * 不再需要插件自建 typert Remote 命名空间。
 *
 * 格式为 __ModuleLoader__ 的 CJS-factory 形式（与内置客户端包一致）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cosplay',
  factory: (require) => {
    const React = require('react')
    const { useSyncExternalStore, useState, useCallback } = React

    const EMPTY_FORM = { name: '', emoji: '', system_prompt: '', description: '', personality: '', style: '', rules: '', behavior: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '' }

    // 酒馆 v2 导入导出映射（与主机侧 store.js 保持一致）
    const CARD_TEXT_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'character_version', 'creator']
    const PLUGIN_FIELDS = ['style', 'rules', 'behavior']
    function toV2Card(role) {
      const data = { name: role.name }
      for (const field of CARD_TEXT_FIELDS) if (role[field]) data[field] = role[field]
      if (Array.isArray(role.tags) && role.tags.length > 0) data.tags = [...role.tags]
      const plugin = { id: role.id }
      if (role.emoji) plugin.emoji = role.emoji
      for (const field of PLUGIN_FIELDS) if (role[field]) plugin[field] = role[field]
      data.extensions = { dshCosplay: plugin }
      return { spec: 'chara_card_v2', spec_version: '2.0', data }
    }
    function fromV2Card(card) {
      const data = card && typeof card === 'object' && card.data && typeof card.data === 'object'
        ? card.data
        : card && typeof card === 'object' && typeof card.name === 'string'
          ? card
          : {}
      const name = typeof data.name === 'string' ? data.name.trim() : ''
      if (!name) throw new Error('导入的角色卡缺少 name 字段')
      const ext = data.extensions && typeof data.extensions === 'object' && data.extensions.dshCosplay ? data.extensions.dshCosplay : {}
      const role = { name, emoji: typeof ext.emoji === 'string' ? ext.emoji : '' }
      for (const field of CARD_TEXT_FIELDS) if (typeof data[field] === 'string') role[field] = data[field]
      if (Array.isArray(data.tags)) role.tags = data.tags.filter((t) => typeof t === 'string')
      for (const field of PLUGIN_FIELDS) if (typeof ext[field] === 'string') role[field] = ext[field]
      if (typeof ext.id === 'string' && ext.id) role.id = ext.id
      return role
    }

    // ── 角色库纯函数（与主机侧 store.js 对齐） ─────────────────────────────────
    function normalizeState(value) {
      const v = value && typeof value === 'object' ? value : {}
      const roles = Array.isArray(v.roles)
        ? v.roles.filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.name === 'string')
        : []
      const activeRole = typeof v.activeRole === 'string' && roles.some((r) => r.id === v.activeRole) ? v.activeRole : null
      return {
        enabled: v.enabled === true,
        thinkingStyle: v.thinkingStyle === 'role' ? 'role' : 'neutral',
        activeRole,
        roles,
      }
    }
    function slugify(name) {
      return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    }
    function nextId(state, name) {
      const base = slugify(name)
      if (base && !state.roles.some((r) => r.id === base)) return base
      const stamp = Date.now().toString(36)
      const rand = Math.floor(Math.random() * 1296).toString(36)
      return `${base || 'role'}-${stamp}${rand}`
    }
    function upsertRole(state, card) {
      const name = typeof card.name === 'string' ? card.name.trim() : ''
      if (!name) throw new Error('角色名不能为空')
      const id = typeof card.id === 'string' && card.id ? card.id : nextId(state, name)
      const exists = state.roles.some((r) => r.id === id)
      const next = exists
        ? { ...state, roles: state.roles.map((r) => (r.id === id ? { ...r, ...card, id, name } : r)) }
        : { ...state, roles: [...state.roles, { ...card, id, name }] }
      return next
    }
    function removeRole(state, id) {
      return {
        ...state,
        roles: state.roles.filter((r) => r.id !== id),
        activeRole: state.activeRole === id ? null : state.activeRole,
      }
    }
    function setActiveRole(state, id) {
      if (id === null) return { ...state, activeRole: null }
      if (!state.roles.some((r) => r.id === id)) throw new Error(`角色不存在: ${id}`)
      return { ...state, activeRole: id }
    }

    // ── settings 远程数据通道（cosplay 命名空间） ────────────────────────────
    function createCosplayStore(getRemote) {
      let snapshot = { status: 'loading', value: undefined, revision: undefined, error: undefined }
      const listeners = new Set()
      const emit = () => { for (const listener of [...listeners]) listener() }
      const set = (next) => { snapshot = next; emit() }
      const remote = () => getRemote()?.settings
      const load = async () => {
        const r = remote()
        if (r === undefined) { set({ status: 'unavailable', value: undefined, revision: undefined, error: 'cosplay 设置通道未就绪' }); return }
        try {
          const res = await r.describe()
          if (!res.ok) { set({ status: 'unavailable', value: undefined, revision: undefined, error: res.error?.message ?? '读取失败' }); return }
          const view = (res.value?.namespaces ?? []).find((n) => n.ns === 'cosplay')
          if (view === undefined) { set({ status: 'unavailable', value: undefined, revision: undefined, error: 'cosplay 设置命名空间未注册' }); return }
          set({ status: 'ready', value: normalizeState(view.value), revision: view.revision, error: undefined })
        } catch (error) {
          set({ status: 'unavailable', value: undefined, revision: undefined, error: String(error && error.message ? error.message : error) })
        }
      }
      const write = async (applyFn) => {
        const r = remote()
        if (r === undefined) throw new Error('cosplay 设置通道未就绪')
        // 序列化：activeRole 的 null 语义 → 空串（schema 无 null 类型）
        const next = applyFn(normalizeState(snapshot.value ?? {}))
        const section = { ...next, activeRole: next.activeRole ?? '' }
        const res = await r.replace('cosplay', section, snapshot.revision)
        if (!res.ok) {
          if (res.error?.code === 'settings/conflict') await load()
          throw new Error(res.error?.message ?? '写入失败')
        }
        set({ status: 'ready', value: normalizeState(res.value?.value ?? next), revision: res.value?.revision ?? snapshot.revision, error: undefined })
        return normalizeState(res.value?.value ?? next)
      }
      return {
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
        getSnapshot: () => snapshot,
        load,
        async setEnabled(enabled) { return write((s) => ({ ...s, enabled: enabled === true })) },
        async setActiveRole(id) { return write((s) => setActiveRole(s, id)) },
        async upsertRole(card) { return write((s) => upsertRole(s, card)) },
        async removeRole(id) { return write((s) => removeRole(s, id)) },
        async setThinkingStyle(style) { return write((s) => ({ ...s, thinkingStyle: style === 'role' ? 'role' : 'neutral' })) },
      }
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0', maxWidth: '720px' },
      card: { border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600 },
      hint: { fontSize: '13px', opacity: 0.72, lineHeight: '1.6' },
      switchTrack: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
      switchBox: { width: '38px', height: '22px', borderRadius: '11px', position: 'relative', transition: 'background .15s', background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.35))' },
      switchKnob: { width: '16px', height: '16px', borderRadius: '50%', background: '#fff', position: 'absolute', top: '3px', left: '3px', transition: 'left .15s' },
      button: { border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))', background: 'transparent', color: 'inherit', borderRadius: '8px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' },
      buttonPrimary: { border: 'none', background: 'var(--dsw-specific-accent, #4d6bfe)', color: '#fff', borderRadius: '8px', padding: '5px 12px', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' },
      input: { background: 'transparent', border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))', borderRadius: '8px', padding: '5px 8px', color: 'inherit', fontSize: '13px', fontFamily: 'inherit', flex: 1, minWidth: '160px' },
      textarea: { background: 'transparent', border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))', borderRadius: '8px', padding: '5px 8px', color: 'inherit', fontSize: '13px', fontFamily: 'inherit', width: '100%', minHeight: '56px', resize: 'vertical', overflowY: 'auto', lineHeight: '1.5', boxSizing: 'border-box' },
      badge: { fontSize: '12px', padding: '1px 8px', borderRadius: '99px', background: 'var(--dsw-specific-accent, #4d6bfe)', color: '#fff' },
      label: { fontSize: '12px', opacity: 0.6, minWidth: '64px' },
    }

    return {
      name: 'cosplay-client',
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        const store = createCosplayStore(() => ctx.remote)
        // 订阅 settings 文档变更，保持页面新鲜（描述镜像由主机侧推送）。
        ctx.effect(() => ctx.remote.$on('settings/document-updated', () => store.load()), 'dsh-cosplay: settings mirror')
        store.load()
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'cosplay', order: 100, label: () => '角色扮演', inject: () => ({ store }) },
            CosplaySection,
          ),
        )
      },
    }

    function CosplaySection({ store }) {
      // store 的 subscribe/getSnapshot 是闭包函数（非 this 方法），可安全裸引用
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const value = snapshot.value

      const [editingId, setEditingId] = useState(null) // null = 新建
      const [form, setForm] = useState(EMPTY_FORM)

      const setField = useCallback((key, v) => setForm((f) => ({ ...f, [key]: v })), [])

      const beginEdit = useCallback((role) => {
        setEditingId(role ? role.id : null)
        setForm(
          role
            ? { name: role.name, emoji: role.emoji ?? '', system_prompt: role.system_prompt ?? '', description: role.description ?? '', personality: role.personality ?? '', style: role.style ?? '', rules: role.rules ?? '', behavior: role.behavior ?? '', scenario: role.scenario ?? '', first_mes: role.first_mes ?? '', mes_example: role.mes_example ?? '', creator_notes: role.creator_notes ?? '' }
            : EMPTY_FORM,
        )
      }, [])

      const reportError = useCallback((error) => {
        if (typeof window !== 'undefined') window.alert(error?.message ?? String(error))
      }, [])

      const save = useCallback(async () => {
        if (!form.name.trim()) return
        try {
          const card = { ...form, name: form.name.trim() }
          if (editingId) card.id = editingId
          const next = await store.upsertRole(card)
          if (!editingId && !next.activeRole) await store.setActiveRole(card.id ?? null)
          setEditingId(null)
          setForm(EMPTY_FORM)
        } catch (error) {
          reportError(error)
        }
      }, [form, editingId, store, reportError])

      const exportRole = useCallback(async (role) => {
        const json = JSON.stringify(toV2Card(role), null, 2)
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${role.name || role.id || 'character'}.json`
        a.click()
        URL.revokeObjectURL(url)
      }, [])

      const importFileRef = React.useRef(null)
      const importRole = useCallback(async (file) => {
        try {
          const text = await file.text()
          const card = fromV2Card(JSON.parse(text))
          const roles = value?.roles ?? []
          if (card.id && roles.some((r) => r.id === card.id)) {
            if (typeof window !== 'undefined' && !window.confirm(`角色「${card.name}」(id=${card.id}) 已存在。\n确定 = 覆盖现有角色\n取消 = 作为新角色导入`)) {
              delete card.id
            }
          }
          const next = await store.upsertRole(card)
          if (!next.activeRole) await store.setActiveRole(card.id ?? null)
          if (importFileRef.current) importFileRef.current.value = ''
        } catch (error) {
          reportError(error)
        }
      }, [store, value, reportError])

      const remove = useCallback(async (id) => {
        if (typeof window !== 'undefined' && !window.confirm(`确定删除角色 ${id} 吗？`)) return
        try {
          await store.removeRole(id)
        } catch (error) {
          reportError(error)
        }
      }, [store, reportError])

      const setActive = useCallback(async (id) => {
        try {
          await store.setActiveRole(id)
        } catch (error) {
          reportError(error)
        }
      }, [store, reportError])

      const toggle = useCallback(async () => {
        try {
          await store.setEnabled(!(value?.enabled === true))
        } catch (error) {
          reportError(error)
        }
      }, [store, value, reportError])

      const setThinkingStyle = useCallback(async (style) => {
        try {
          await store.setThinkingStyle(style)
        } catch (error) {
          reportError(error)
        }
      }, [store, reportError])

      if (snapshot.status === 'loading') {
        return React.createElement('div', { style: styles.hint }, '角色扮演设置加载中…')
      }
      if (snapshot.status === 'unavailable') {
        return React.createElement(
          'div',
          { style: styles.hint },
          `角色库不可用：cosplay 设置通道未就绪。${snapshot.error ? `（${snapshot.error}）` : ''}`,
        )
      }

      const enabled = value?.enabled === true
      const thinkingStyle = value?.thinkingStyle ?? 'neutral'
      const roles = value?.roles ?? []
      const activeRole = value?.activeRole ?? null

      return React.createElement(
        'div',
        { style: styles.page },
        // ── 主开关 ──
        React.createElement(
          'div',
          { style: styles.card },
          React.createElement('div', { style: styles.title }, '🎭 角色扮演'),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement(
              'label',
              { style: styles.switchTrack },
              React.createElement(
                'span',
                {
                  style: { ...styles.switchBox, background: enabled ? 'var(--dsw-specific-accent, #4d6bfe)' : styles.switchBox.background },
                  onClick: toggle,
                },
                React.createElement('span', { style: { ...styles.switchKnob, left: enabled ? '19px' : '3px' } }),
              ),
              React.createElement('span', null, enabled ? 'Cosplay 模式：开启' : 'Cosplay 模式：关闭'),
            ),
            React.createElement(
              'span',
              { style: styles.hint },
              '开启后，所有会话（含子代理）将以当前激活角色的设定与语气对话；关闭后下一轮对话即回退默认人格。',
            ),
          ),
          React.createElement(
            'div',
            { style: styles.hint },
            enabled
              ? activeRole
                ? `当前扮演：${roles.find((r) => r.id === activeRole)?.name ?? activeRole}`
                : '已开启但未选择角色 —— 请在下方的角色列表中「设为当前」。'
              : '已关闭：开启后生效。',
          ),
          // ── 思考风格（全局） ──
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '思考风格'),
            React.createElement(
              'button',
              { style: { ...styles.button, ...(thinkingStyle !== 'role' ? { borderColor: 'var(--dsw-specific-accent, #4d6bfe)' } : {}) }, onClick: () => setThinkingStyle('neutral') },
              '中立思考',
            ),
            React.createElement(
              'button',
              { style: { ...styles.button, ...(thinkingStyle === 'role' ? { borderColor: 'var(--dsw-specific-accent, #4d6bfe)' } : {}) }, onClick: () => setThinkingStyle('role') },
              '角色化思考',
            ),
          ),
          React.createElement(
            'div',
            { style: styles.hint },
            thinkingStyle !== 'role'
              ? '中立思考：模型思考过程保持专业分析，仅最终回复扮演角色（推荐）。'
              : '角色化思考：模型的思考过程也保持角色人设与口吻，沉浸感更强（不稳定触发，可能影响Agent任务能力，谨慎开启）。',
          ),
        ),
        // ── 角色列表 ──
        React.createElement(
          'div',
          { style: styles.card },
          React.createElement('div', { style: styles.row },
            React.createElement('div', { style: styles.title }, '角色库'),
            React.createElement('button', { style: styles.buttonPrimary, onClick: () => beginEdit(null) }, '＋ 新建角色'),
            React.createElement('button', { style: styles.button, onClick: () => importFileRef.current?.click() }, '导入角色卡'),
            React.createElement('input', { ref: importFileRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: (e) => { if (e.target.files?.[0]) importRole(e.target.files[0]) } }),
          ),
          roles.length === 0
            ? React.createElement('div', { style: styles.hint }, '角色库为空。点击「新建角色」创建第一个角色，或用 cosplay_upsert 工具。')
            : React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                roles.map((role) =>
                  React.createElement(
                    'div',
                    { key: role.id, style: styles.row },
                    React.createElement('span', null, `${role.emoji ?? ''} ${role.name}`),
                    role.id === activeRole
                      ? React.createElement('span', { style: styles.badge }, '当前')
                      : null,
                    React.createElement('span', { style: { ...styles.hint, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, role.description ?? ''),
                    React.createElement('button', { style: styles.button, onClick: () => setActive(role.id) }, '设为当前'),
                    React.createElement('button', { style: styles.button, onClick: () => beginEdit(role) }, '编辑'),
                    React.createElement('button', { style: styles.button, onClick: () => exportRole(role) }, '导出'),
                    React.createElement('button', { style: styles.button, onClick: () => remove(role.id) }, '删除'),
                  ),
                ),
              ),
        ),
        // ── 新建 / 编辑表单 ──
        React.createElement(
          'div',
          { style: styles.card },
          React.createElement('div', { style: styles.title }, editingId ? `编辑角色：${editingId}` : '新建角色'),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '名称 *'),
            React.createElement('input', { style: styles.input, value: form.name, onChange: (e) => setField('name', e.target.value), placeholder: '角色名' }),
            React.createElement('span', { style: styles.label }, '头像'),
            React.createElement('input', { style: { ...styles.input, maxWidth: '80px' }, value: form.emoji, onChange: (e) => setField('emoji', e.target.value), placeholder: '📚' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '系统提示词'),
            React.createElement('textarea', { style: { ...styles.textarea, minHeight: '96px' }, value: form.system_prompt, onChange: (e) => setField('system_prompt', e.target.value), placeholder: '可选：给角色附加总体扮演指令。' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '身份'),
            React.createElement('textarea', { style: styles.textarea, value: form.description, onChange: (e) => setField('description', e.target.value), placeholder: '身份与背景设定（我是谁）' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '性格'),
            React.createElement('textarea', { style: styles.textarea, value: form.personality, onChange: (e) => setField('personality', e.target.value), placeholder: '性格核心与层次' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '语气'),
            React.createElement('textarea', { style: { ...styles.textarea, minHeight: '64px' }, value: form.style, onChange: (e) => setField('style', e.target.value), placeholder: '说话风格（怎么说话）' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '守则'),
            React.createElement('textarea', { style: { ...styles.textarea, minHeight: '64px' }, value: form.rules, onChange: (e) => setField('rules', e.target.value), placeholder: '行为守则（该做什么 / 不做什么）' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '行为'),
            React.createElement('textarea', { style: styles.textarea, value: form.behavior, onChange: (e) => setField('behavior', e.target.value), placeholder: '行为模式 / 私密互动' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '场景'),
            React.createElement('textarea', { style: styles.textarea, value: form.scenario, onChange: (e) => setField('scenario', e.target.value), placeholder: '场景 / 世界观 / 关系设定' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '示例对话'),
            React.createElement('textarea', { style: styles.textarea, value: form.mes_example, onChange: (e) => setField('mes_example', e.target.value), placeholder: '可选：few-shot 示例' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '开场白'),
            React.createElement('textarea', { style: { ...styles.textarea, minHeight: '64px' }, value: form.first_mes, onChange: (e) => setField('first_mes', e.target.value), placeholder: '可选' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('span', { style: styles.label }, '备注'),
            React.createElement('textarea', { style: { ...styles.textarea, minHeight: '64px' }, value: form.creator_notes, onChange: (e) => setField('creator_notes', e.target.value), placeholder: '创建者笔记（不注入人格）' }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('button', { style: styles.buttonPrimary, onClick: save }, '保存'),
            editingId ? React.createElement('button', { style: styles.button, onClick: () => { setEditingId(null); setForm(EMPTY_FORM) } }, '取消') : null,
          ),
        ),
      )
    }
  },
})
