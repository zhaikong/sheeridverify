import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// 随机整数
const sample = range =>
  randomInt(range.min, range.max + 1);

// 延迟范围校验
function validateRange(name, range) {
  if (
    !range ||
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new TypeError(`Invalid delay range: ${name}`);
  }
}

export function createInteraction(
  config,
  { signal, log = () => {} } = {}
) {
  // 检查配置
  for (const key of [
    'fieldDelayMs',
    'submitDelayMs',
    'keyDelayMs',
  ]) {
    validateRange(key, config[key]);
  }

  // 中断检查
  const checkAbort = () => {
    signal?.throwIfAborted();
  };

  // 统一随机等待
  const pause = async (range, stage, field) => {
    checkAbort();

    const durationMs = sample(range);

    log('interaction_delay', {
      stage,
      field,
      durationMs,
    });

    if (durationMs > 0) {
      await delay(durationMs, undefined, { signal });
    }
  };

  return {

    // 字段操作之前等待
    beforeField: field =>
      pause(config.fieldDelayMs, 'fill', field),

    // 下拉选项操作之前等待
    beforeOption: field =>
      pause(config.fieldDelayMs, 'select_option', field),

    // 提交之前等待
    beforeSubmit: () =>
      pause(config.submitDelayMs, 'submit', 'submit'),

    // 随机键盘输入
    async typeText(locator, value, options = {}) {
      const {
        field = 'input',
        clear = true,
        clearMode = 'fill',
      } = options;

      checkAbort();

      // 只聚焦；重复点击会关闭调用方已经打开的下拉菜单。
      await locator.focus();

      // 默认沿用 fill 清空方式，避免快捷键改变下拉控件状态。
      if (clear) {
        if (clearMode === 'keyboard') {
          await locator.press('ControlOrMeta+A');
          await locator.press('Backspace');
        } else if (clearMode === 'fill') {
          await locator.fill('');
        } else {
          throw new TypeError(`Invalid clearMode: ${clearMode}`);
        }
      }

      // 按 Unicode 字符遍历
      const characters = Array.from(
        String(value ?? '').replace(/\r\n?/g, '\n')
      );

      for (let i = 0; i < characters.length; i++) {
        checkAbort();

        const character = characters[i];

        // 输入当前字符
        if (character === '\n') {
          await locator.press('Enter');
        } else {
          await locator.pressSequentially(character);
        }

        // 每个字符之间随机等待
        if (i < characters.length - 1) {
          await pause(
            config.keyDelayMs,
            'type',
            field
          );
        }
      }

      log('interaction_typed', {
        field,
        characterCount: characters.length,
      });
    },
  };
}
