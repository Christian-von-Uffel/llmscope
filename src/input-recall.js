// Node-only: the text prompt the CLI asks for a list of keywords with.
//
// It is @inquirer/prompts' `input` plus the two things a list you retype every session needs: up-arrow recall of
// earlier answers, and a key that opens the picker. Recall costs almost nothing because readline already does it —
// its own up-arrow handler rewrites rl.line before this prompt's handler runs, and the handler's default branch
// copies rl.line into the displayed value. Seeding rl.history is the whole feature. It has to happen in here
// rather than at the call site because `input` gives no way to reach its readline instance from outside.
import {
  createPrompt, useState, useEffect, useKeypress, usePrefix, makeTheme,
  isBackspaceKey, isEnterKey, isTabKey, isUpKey, isDownKey,
} from '@inquirer/core';

/** What the prompt resolves to when the recall key is pressed: not an answer, a request to open the picker. */
export class Recall {
  constructor(typed = '') { this.typed = typed; }
}

export const isRecall = (v) => v instanceof Recall;

/** Ctrl-R, the shell's key for "what did I type before". Node's readline leaves it alone, so it is ours. */
const isRecallKey = (key) => Boolean(key.ctrl) && key.name === 'r';

export const inputWithRecall = createPrompt((config, done) => {
  const { prefill = 'tab', history = [], recall = false, hint = '' } = config;
  const theme = makeTheme({ validationFailureMode: 'keep' }, config.theme);
  const [status, setStatus] = useState('idle');
  const [defaultValue, setDefaultValue] = useState(String(config.default ?? ''));
  const [errorMsg, setError] = useState();
  const [value, setValue] = useState('');
  // What was typed before the first up-arrow. Readline drops it when you walk back off the end of its history,
  // so the prompt keeps a copy and hands it back: up then down returns you to your own text, not to an empty line.
  const [draft, setDraft] = useState(null);
  const prefix = usePrefix({ status, theme });

  async function validate(v) {
    if (config.required && !v) return 'You must provide a value';
    if (typeof config.validate === 'function') return (await config.validate(v)) || 'You must provide a valid value';
    return true;
  }

  useKeypress(async (key, rl) => {
    if (status !== 'idle') return; // ignore keys while validating
    if (recall && isRecallKey(key)) {
      rl.clearLine(0);
      setStatus('done');
      done(new Recall(value));
      return;
    }
    if (isEnterKey(key)) {
      const answer = value || defaultValue;
      setStatus('loading');
      const isValid = await validate(answer);
      if (isValid === true) {
        setValue(answer);
        setStatus('done');
        done(answer);
        return;
      }
      // Put the text back so a typo is fixed rather than retyped: the line event cleared it.
      rl.write(answer);
      setValue(answer);
      setError(isValid);
      setStatus('idle');
      return;
    }
    if (history.length && (isUpKey(key) || isDownKey(key))) {
      // Readline has already walked its history and rewritten rl.line; this only keeps the view in step.
      if (draft === null) setDraft(value);
      if (isDownKey(key) && rl.historyIndex === -1 && draft) {
        rl.clearLine(0);
        rl.write(draft);
        setValue(draft);
        setDraft(null);
        return;
      }
      setValue(rl.line);
      setError(undefined);
      return;
    }
    if (isBackspaceKey(key) && !value) {
      setDefaultValue('');
      return;
    }
    if (isTabKey(key) && !value) {
      setDefaultValue('');
      rl.clearLine(0);
      rl.write(defaultValue);
      setValue(defaultValue);
      return;
    }
    setValue(rl.line);
    setError(undefined);
  });

  useEffect((rl) => {
    // Most recent first, which is the order readline walks: one press of up is the last batch used.
    if (history.length) rl.history = history.map(String);
    if (prefill === 'editable' && defaultValue) {
      rl.write(defaultValue);
      setValue(defaultValue);
    }
  }, []);

  const message = theme.style.message(config.message, status);
  let shown = value;
  if (typeof config.transformer === 'function') shown = config.transformer(value, { isFinal: status === 'done' });
  else if (status === 'done') shown = theme.style.answer(value);
  const defaultStr = defaultValue && status !== 'done' && !value ? theme.style.defaultAnswer(defaultValue) : undefined;
  const below = errorMsg ? theme.style.error(errorMsg) : (status === 'idle' && hint ? hint : '');
  return [[prefix, message, defaultStr, shown].filter((v) => v !== undefined).join(' '), below];
});
