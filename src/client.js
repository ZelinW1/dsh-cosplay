/**
 * dsh-cosplay — 浏览器侧（dsh.client 声明，包入口 dsh-cosplay/client）。
 *
 * 设置页新增「角色扮演」页（settings.section 列表条目），承载：
 *   - 全局开关（enabled）；
 *   - 角色库管理：列表 / 激活 / 新建 / 编辑 / 删除；
 *   - 角色卡字段：name / emoji / description / style / rules / greeting / sample。
 *
 * 数据通道：插件自有的 typert Remote 命名空间 `cosplay`。
 * 0.2.x 的三条硬约束（依据 dsh-api-gateway / dsh-typert-registry / dsh-client-modules
 * 的实现，勿凭 0.1.x 记忆修改）：
 *   1. 描述符的**参数** codec 必须是 `strict` 且带 `typeSymbol` 与 `create` 工厂，
 *      否则客户端 `requireStrictInputs` 会让 `$mount` 抛错；result 可用 `src-json`。
 *   2. 挂载必须由 async `apply` 自身 await 并 return disposer；**不要**包在
 *      `ctx.effect(async () => ...)` 里——那里抛出的 rejection 会被 cordis 静默吞掉。
 *   3. 挂载后直接用 `ctx.remote.cosplay` 取命名空间；**不要**在本插件 inject
 *      `remote.cosplay`（自挂自取会自依赖死锁）。
 *
 * 格式为 __ModuleLoader__ 的 CJS-factory 形式（id 必须等于包名，与内置客户端包一致）。
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

    // ── typert Remote 描述符（参数与主机侧一致，result 走 src-json） ──────────
    // 0.2.x 客户端描述符契约（两条都踩过坑，勿改）：
    //   - **参数** codec 必须是 strict（dsh-api-gateway 的 requireStrictInputs 对每个
    //     参数断言 mode === 'strict'，否则 $mount 直接抛错）。create() 在客户端只作
    //     校验令牌、永不被调用（客户端走独立 DescriptorStore，不写 packages/schemas），
    //     因此 `() => ({})` 即可。
    //   - **result** 可以是 src-json：宿主对 src-json 一直放行，客户端也不解码结果。
    const strictCodec = (typeSymbol) => ({ mode: 'strict', typeSymbol, create: () => ({}) })
    const resultCodec = (typeSymbol) => ({ mode: 'src-json', typeSymbol })
    const COSPLAY_INVOCATIONS = [
      { id: 'dsh-cosplay#cosplay/getState', service: 'cosplay', namespace: 'cosplay', method: 'getState', invocation: { kind: 'direct' }, parameters: [], result: resultCodec('dsh-cosplay#CosplayState') },
      { id: 'dsh-cosplay#cosplay/upsertRole', service: 'cosplay', namespace: 'cosplay', method: 'upsertRole', invocation: { kind: 'direct' }, parameters: [{ name: 'card', wire: 'card', source: 'json', codec: strictCodec('dsh-cosplay#RoleCard') }], result: resultCodec('dsh-cosplay#CosplayState') },
      { id: 'dsh-cosplay#cosplay/removeRole', service: 'cosplay', namespace: 'cosplay', method: 'removeRole', invocation: { kind: 'direct' }, parameters: [{ name: 'id', wire: 'id', source: 'json', codec: strictCodec('dsh-cosplay#RoleId') }], result: resultCodec('dsh-cosplay#CosplayState') },
      { id: 'dsh-cosplay#cosplay/setActiveRole', service: 'cosplay', namespace: 'cosplay', method: 'setActiveRole', invocation: { kind: 'direct' }, parameters: [{ name: 'id', wire: 'id', source: 'json', codec: strictCodec('dsh-cosplay#RoleId') }], result: resultCodec('dsh-cosplay#CosplayState') },
      { id: 'dsh-cosplay#cosplay/setEnabled', service: 'cosplay', namespace: 'cosplay', method: 'setEnabled', invocation: { kind: 'direct' }, parameters: [{ name: 'enabled', wire: 'enabled', source: 'json', codec: strictCodec('dsh-cosplay#Enabled') }], result: resultCodec('dsh-cosplay#CosplayState') },
      { id: 'dsh-cosplay#cosplay/setThinkingStyle', service: 'cosplay', namespace: 'cosplay', method: 'setThinkingStyle', invocation: { kind: 'direct' }, parameters: [{ name: 'style', wire: 'style', source: 'json', codec: strictCodec('dsh-cosplay#ThinkingStyle') }], result: resultCodec('dsh-cosplay#CosplayState') },
    ]
    const COSPLAY_REMOTE = { package: 'dsh-cosplay', descriptors: COSPLAY_INVOCATIONS }

    /** 挂载后返回 Remote 命名空间；未就绪返回 undefined。 */
    function createCosplayStore(getRemote) {
      let snapshot = { status: 'loading', value: undefined }
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const settle = (next) => {
        snapshot = next
        emit()
      }
      const call = async (fn) => {
        const remote = getRemote()
        if (remote === undefined) {
          settle({ status: 'unavailable', value: undefined, error: 'cosplay Remote 未挂载' })
          return undefined
        }
        try {
          return await fn(remote)
        } catch (error) {
          settle({ status: 'unavailable', value: undefined, error: String(error && error.message ? error.message : error) })
          return undefined
        }
      }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => snapshot,
        /** 把挂载期的失败显式落到快照，界面据此显示原因而不是停在"加载中"。 */
        fail(error) {
          settle({ status: 'unavailable', value: undefined, error: String(error && error.message ? error.message : error) })
        },
        async load() {
          const res = await call((r) => r.getState())
          if (res === undefined) return
          if (res.ok) settle({ status: 'ready', value: res.value })
          else settle({ status: 'unavailable', value: undefined, error: res.error?.message ?? '读取失败' })
        },
        /** 执行一次写操作；成功后用返回值刷新快照。 */
        async mutate(fn) {
          const res = await call(fn)
          if (res === undefined) return undefined
          if (res.ok) {
            settle({ status: 'ready', value: res.value })
            return res.value
          }
          throw new Error(res.error?.message ?? '写入失败')
        },
      }
    }

    return {
      name: 'cosplay-client',
      inject: ['remote', 'slots', 'connection'],
      /**
       * 挂载本插件的 Remote 命名空间并注册设置页分区。
       *
       * 0.2.x 的三条硬约束（全部踩过坑，依据运行时实现）：
       *   1. **不要**用 `ctx.effect(async () => { await ctx.remote.$mount(...) })` 包挂载。
       *      cordis 的 effect 收尾是 `task?.catch(() => dispose()).catch(logger.error)`，
       *      第一个 catch 会返回 undefined，于是 rejection 连 logger 都到不了——浏览器侧
       *      只表现为设置页永远"加载中…"。改为让 apply 自身 async 并 return disposer，
       *      失败会把 fiber 置为 FAILED 并出现在插件面板的失败清单里。
       *   2. 读取 `ctx.remote.<ns>` 前**必须**用 `ctx.inject(['remote.<ns>'], cb)` 声明，
       *      否则 Reflect 会抛 `cannot get property "remote.cosplay" without inject`。
       *   3. 注入必须在 `$mount` **之后**发起：注入发生在 apply 体内，此时 fiber 已在
       *      激活流程中，若在插件顶层 inject 自己的命名空间会自依赖死锁。挂载完成后
       *      该服务已存在，`ctx.inject` 随即解析。
       * @param ctx - 客户端插件上下文。
       * @returns 卸载函数。
       */
      async apply(ctx) {
        let cosplayRemote = undefined
        let unregister = undefined
        const store = createCosplayStore(() => cosplayRemote)
        const report = (error) => {
          const message = String(error && error.message ? error.message : error)
          store.fail(`Remote 挂载失败：${message}`)
          console.error('[dsh-cosplay] Remote 挂载失败:', message, error)
          return new Error(`COSPLAY_MOUNT_FAILED: ${message}`)
        }
        try {
          const disposeRemote = await ctx.remote.$mount(COSPLAY_REMOTE)
          // 挂载已就绪，现在声明依赖并消费命名空间（见上文第 2/3 条）
          const ui = ctx.inject(['remote.cosplay', 'slots'], (child) => {
            const remote = child.remote?.cosplay
            if (remote === undefined) {
              throw new Error('the cosplay Remote namespace did not resolve after mount')
            }
            cosplayRemote = remote
            unregister = child.slots.inject('settings.section', () =>
              child.slots.register(
                // 0.2.x 的 slots.register 以 options.priority 为主排序键（值越小越先渲染），
                // order 仍作为同优先级内的次级键。
                { name: 'settings.section', id: 'cosplay', priority: 100, label: '角色扮演' },
                () => React.createElement(CosplaySection, { store }),
              ),
            )
            void store.load()
          })
          try {
            await ui
          } catch (error) {
            await ui.dispose()
            await disposeRemote()
            throw error
          }
          return async () => {
            if (typeof unregister === 'function') unregister()
            await ui.dispose()
            await disposeRemote()
          }
        } catch (error) {
          throw report(error)
        }
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
        if (typeof window !== 'undefined') window.alert(error.message)
      }, [])

      const save = useCallback(async () => {
        if (!form.name.trim()) return
        try {
          const card = { ...form, name: form.name.trim() }
          if (editingId) card.id = editingId
          await store.mutate((r) => r.upsertRole(card))
          if (!editingId && !value?.activeRole) await store.mutate((r) => r.setActiveRole(card.id ?? null))
          setEditingId(null)
          setForm(EMPTY_FORM)
        } catch (error) {
          reportError(error)
        }
      }, [form, editingId, value, store, reportError])

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
          // id 冲突确认：相同 id 默认覆盖；取消则去掉 id 新建（不覆盖）
          if (card.id && (value?.roles ?? []).some((r) => r.id === card.id)) {
            if (typeof window !== 'undefined' && !window.confirm(`角色「${card.name}」(id=${card.id}) 已存在。\n确定 = 覆盖现有角色\n取消 = 作为新角色导入`)) {
              delete card.id
            }
          }
          await store.mutate((r) => r.upsertRole(card))
          if (!value?.activeRole) await store.mutate((r) => r.setActiveRole(card.id ?? null))
          if (importFileRef.current) importFileRef.current.value = ''
        } catch (error) {
          reportError(error)
        }
      }, [store, value, reportError])

      const remove = useCallback(async (id) => {
        if (typeof window !== 'undefined' && !window.confirm(`确定删除角色 ${id} 吗？`)) return
        try {
          await store.mutate((r) => r.removeRole(id))
        } catch (error) {
          reportError(error)
        }
      }, [store, reportError])

      const setActive = useCallback(async (id) => {
        try {
          await store.mutate((r) => r.setActiveRole(id))
        } catch (error) {
          reportError(error)
        }
      }, [store, reportError])

      const toggle = useCallback(async () => {
        try {
          await store.mutate((r) => r.setEnabled(!(value?.enabled === true)))
        } catch (error) {
          reportError(error)
        }
      }, [store, value, reportError])

      const setThinkingStyle = useCallback(async (style) => {
        try {
          await store.mutate((r) => r.setThinkingStyle(style))
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
          `角色库不可用：cosplay Remote 通道未就绪。${snapshot.error ? `（${snapshot.error}）` : ''}`,
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
