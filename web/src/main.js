import { createApp, ref, computed } from 'vue'
import hljs from 'highlight.js/lib/core'
import lua from 'highlight.js/lib/languages/lua'
import 'highlight.js/styles/tokyo-night-dark.css'
import './style.css'
import { examples } from './examples.js'

hljs.registerLanguage('lua', lua)

createApp({
  setup() {
    const script = ref(examples[0].script)
    const variables = ref([])
    const output = ref(null)
    const running = ref(false)
    const lastTime = ref(null)
    const activeExample = ref(0)
    const showVars = ref(false)
    const codeTextarea = ref(null)

    const highlighted = computed(() => {
      if (!script.value) return '&nbsp;'
      return hljs.highlight(script.value + '\n', { language: 'lua' }).value
    })

    function syncScroll() {
      const ta = codeTextarea.value
      if (!ta) return
      const pre = ta.previousElementSibling
      if (pre) {
        pre.scrollTop = ta.scrollTop
        pre.scrollLeft = ta.scrollLeft
      }
    }

    function loadExample(i) {
      activeExample.value = i
      script.value = examples[i].script
      variables.value = examples[i].variables.map(v => ({ ...v }))
      showVars.value = variables.value.length > 0
      output.value = null
      lastTime.value = null
    }

    async function execute() {
      if (running.value || !script.value.trim()) return
      running.value = true
      output.value = null
      lastTime.value = null

      const vars = {}
      for (const v of variables.value) {
        if (v.key.trim()) vars[v.key.trim()] = v.value
      }

      try {
        const resp = await fetch('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script: script.value, variables: vars }),
        })
        const data = await resp.json()
        output.value = data
        lastTime.value = data.time_ms
      } catch (e) {
        output.value = { error: 'Request failed: ' + e.message, logs: [] }
      } finally {
        running.value = false
      }
    }

    // Resizable panes
    const editorWidth = ref(50)
    const dragging = ref(false)

    function startDrag(e) {
      dragging.value = true
      const panes = e.target.parentElement
      const rect = panes.getBoundingClientRect()

      function onMove(ev) {
        const x = (ev.clientX || ev.touches?.[0]?.clientX) - rect.left
        const pct = Math.min(Math.max((x / rect.width) * 100, 20), 80)
        editorWidth.value = pct
      }

      function onUp() {
        dragging.value = false
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onUp)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('touchmove', onMove)
      document.addEventListener('touchend', onUp)
    }

    loadExample(0)

    return {
      script, variables, output, running, lastTime,
      activeExample, showVars, examples, highlighted,
      codeTextarea, syncScroll,
      editorWidth, dragging, startDrag,
      loadExample, execute,
    }
  }
}).mount('#app')
