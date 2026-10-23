<script setup>
/**
 * 全局路径栏 —— 根页只有路径; 二级起箭头贴在路径最左边
 * ==================================================
 * 层级由各视图用 usePagePath 写进 usePathStore, 这里只读当前路由那一份。
 * 箭头 = 返回上一级(crumb 的 onClick), 与父级 crumb 点击同一动作;
 * 当前 crumb 加粗, 可复制的 crumb 后面挂 📋。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { usePathStore } from '@/stores/usePathStore.js'
import { useUiStore } from '@/stores/useUiStore.js'

const route = useRoute()
const store = usePathStore()
const ui = useUiStore()

const crumbs = computed(() => store.paths[route.name] || [])
const parent = computed(() => (crumbs.value.length > 1 ? crumbs.value[crumbs.value.length - 2] : null))

function goParent() {
  /* back 是可选覆盖: 独立标签页的「全部标签」点下去是回列表, 而箭头沿用
     旧的智能返回(从详情页/光箱来的回来源页) —— 两者标签文字一样, 动作不同。 */
  const p = parent.value
  if (p?.back) p.back()
  else p?.onClick?.()
}

async function copyCrumb(c) {
  if (!c?.copy) return
  await ui.copy(c.copy)
  ui.ok(`📋 已复制${c.copyLabel || '名称'}: ${c.copy}`, 'ok', 1400)
}
</script>

<template>
  <div v-if="crumbs.length" class="pathbar" data-test="pathbar">
    <button
      v-if="parent"
      class="back"
      type="button"
      :title="parent.back ? '返回上一页' : `返回 ${parent.label}`"
      aria-label="返回上一级"
      data-test="path-back"
      @click="goParent"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.5 5.5L8 12l6.5 6.5" />
        <path d="M8.2 12H20" />
      </svg>
    </button>

    <div class="crumbs">
      <template v-for="(c, i) in crumbs" :key="i + ':' + c.label">
        <span v-if="i" class="sep" aria-hidden="true">&gt;</span>
        <span class="crumb-item" :class="{ cur: i === crumbs.length - 1 }">
          <button
            v-if="i < crumbs.length - 1"
            class="crumb"
            type="button"
            data-test="path-crumb"
            @click="c.onClick?.()"
          >
            <span class="lbl">{{ c.label }}</span>
            <span v-if="c.sub" class="sub">{{ c.sub }}</span>
          </button>
          <span v-else class="crumb" aria-current="page" data-test="path-current">
            <span class="lbl">{{ c.label }}</span>
            <span v-if="c.sub" class="sub">{{ c.sub }}</span>
          </span>
          <button
            v-if="c.copy"
            class="copy"
            type="button"
            :title="`复制${c.copyLabel || '名称'}(${c.copy})`"
            @click="copyCrumb(c)"
          >📋</button>
        </span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pathbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 38px;
  padding: 4px 14px;
  min-width: 0;
  /* 与顶栏同色: 再横一条白会显得像第二层顶栏(顶栏当初就是为此改成 --bg) */
  background: var(--bg);
  border-bottom: 1px solid var(--border-soft);
}
.back {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 50%;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--t-fast), border-color var(--t-fast), background var(--t-fast);
}
.back:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.back svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: none;
}
.crumbs::-webkit-scrollbar { display: none; }
.crumb-item { display: inline-flex; align-items: center; flex: 0 0 auto; }
.crumb {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 2px 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: nowrap;
}
button.crumb { cursor: pointer; }
button.crumb:hover { color: var(--accent); background: var(--accent-soft); }
.crumb-item.cur .crumb { color: var(--text); font-weight: 600; cursor: default; }
.sub { color: var(--faint); font-size: 11px; font-weight: 400; }
.sep { flex: 0 0 auto; color: var(--faint); font-size: 11px; }
.copy {
  flex: 0 0 auto;
  padding: 1px 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--faint);
  font-size: 10px;
  line-height: 1.4;
  cursor: pointer;
}
.copy:hover { color: var(--accent); background: var(--accent-soft); }
</style>
