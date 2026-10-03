async (page) => {
  // Run with playwright-cli run-code --filename tests/voice-browser.js against Vite on 5191.
  // Generated browser audio and API fixtures exercise the UI; this is not a phone model/hearing test.
  const calls = [], failures = []
  let checkCount = 0
  let uploadReply = '语音文字', askDelay = false
  const emptyCanvas = JSON.stringify({ version: 3, shapes: {}, groups: {}, order: [], workspace: { x: 0, y: 0, w: 3000, h: 2000 }, camera: { x: 0, y: 0, zoom: 1 } })
  const wave = Buffer.alloc(44 + 3200); wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(3200, 40)
  await page.unroute('**/api/**')
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method()
    calls.push({ path: url.pathname, method, bytes: request.postDataBuffer()?.length || 0, json: request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : null })
    const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
    if (url.pathname === '/api/auth/me') return json({ user: { id: 'voice_fixture_user', email: 'fixture@example.test', createdAt: 1 } })
    if (url.pathname === '/api/voice/status') return json({ available: true, capabilities: { transcribe: true, chat: true, speech: true }, limits: { recordingSeconds: 20, speechCharacters: 120 } })
    if (url.pathname === '/api/voice/transcribe') return json({ text: uploadReply, durationMs: request.postDataBuffer().length / 32 })
    if (url.pathname === '/api/voice/ask') {
      if (askDelay) await new Promise(resolve => setTimeout(resolve, 1200))
      return json({ answer: '当前项目有 2 个问题等待验收。', spokenAnswer: '有两个问题等待验收。', sources: [{ kind: 'project', id: 'voice_fixture_project', title: '语音测试项目' }], dataAnswer: true, readOnly: true, summaryOnly: true, contextTruncated: true, questionTruncated: false })
    }
    if (url.pathname === '/api/voice/speech') return route.fulfill({ contentType: 'audio/wav', body: wave })
    if (url.pathname === '/api/management/projects') return json([{ id: 'voice_fixture_project', name: '语音测试项目' }])
    if (url.pathname === '/api/management/notifications') return json([])
    if (url.pathname === '/api/projects') return json([{ id: 'voice_fixture_canvas', title: '语音测试画布', createdAt: 1, updatedAt: 1, permission: 'owner' }])
    if (url.pathname === '/api/projects/voice_fixture_canvas') return json(method === 'GET' ? { id: 'voice_fixture_canvas', title: '语音测试画布', content: emptyCanvas, createdAt: 1, updatedAt: 1, permission: 'owner' } : { ok: true })
    return json([])
  })
  await page.addInitScript(() => {
    window.__voiceQa = { captures: 0, activeTracks: 0, urls: new Set() }
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = blob => { const url = create(blob); window.__voiceQa.urls.add(url); return url }
    URL.revokeObjectURL = url => { window.__voiceQa.urls.delete(url); revoke(url) }
    navigator.mediaDevices.getUserMedia = async () => {
      if (window.__voiceQa.denyPermission) throw new DOMException('fixture permission denied', 'NotAllowedError')
      if (window.__voiceQa.deferPermission) await new Promise(resolve => { window.__voiceQa.resolvePermission = resolve })
      window.__voiceQa.captures++; window.__voiceQa.activeTracks++
      const context = new AudioContext(), oscillator = context.createOscillator(), destination = context.createMediaStreamDestination()
      oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start(); await context.resume()
      const track = destination.stream.getTracks()[0], stop = track.stop.bind(track)
      track.stop = () => { if (track.readyState !== 'ended') window.__voiceQa.activeTracks--; oscillator.stop(); void context.close(); stop() }
      return destination.stream
    }
  })
  const check = (condition, text) => { checkCount++; if (!condition) failures.push(text) }
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('http://127.0.0.1:5191/editor/voice_fixture_canvas')
  await page.getByRole('button', { name: '语音输入到光标位置' }).waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="项目名称"]')?.value === '语音测试画布')
  check(await page.evaluate(() => window.__voiceQa.captures) === 0, 'microphone must not start automatically')
  await page.evaluate(async () => {
    const { useCanvasStore } = await import('/src/store/useCanvasStore.ts'), { createShape } = await import('/src/canvas/types.ts')
    useCanvasStore.getState().addShape({ ...createShape('text', 80, 80, 260, 70), text: '前后', name: '语音测试文本', fontSize: 24 })
    useCanvasStore.getState().setCamera({ x: 0, y: 0, zoom: 1 })
  })
  const canvas = page.locator('canvas.touch-none'); await canvas.dblclick({ position: { x: 150, y: 110 } })
  const editor = page.getByRole('textbox', { name: '编辑 语音测试文本 文本' }); await editor.waitFor()
  await editor.evaluate(element => { element.focus(); element.setSelectionRange(1, 1) })
  await page.getByRole('button', { name: '语音输入到光标位置' }).click()
  await page.getByText('正在聆听', { exact: true }).waitFor()
  check(await editor.count() === 1, 'canvas editor must not blur/commit on microphone click')
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'output/playwright/voice-recording.png' })
  await page.getByRole('button', { name: '完成并识别' }).click()
  await page.getByText('已插入文字', { exact: true }).waitFor()
  check(await editor.inputValue() === '前语音文字后', 'recognized text must enter original canvas cursor and React state')
  check(await page.evaluate(() => window.__voiceQa.activeTracks) === 0, 'microphone tracks must stop after recording')
  await page.getByRole('button', { name: '关闭识别结果' }).click()
  await page.getByRole('button', { name: '语音输入到光标位置' }).click()
  await page.getByText('正在聆听', { exact: true }).waitFor()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  check(calls.filter(item => item.path === '/api/voice/transcribe').length === 1, 'cancel must not upload audio')
  check(await page.evaluate(() => window.__voiceQa.activeTracks) === 0, 'cancel must stop microphone tracks')
  const insert = await page.evaluate(async () => {
    const { captureVoiceTarget, insertVoiceText } = await import('/src/utils/voiceInsertion.ts')
    const field = document.createElement('textarea'); field.value = '未变'; document.body.append(field); field.focus(); field.setSelectionRange(1, 1)
    const target = captureVoiceTarget(field); field.value = '他人修改'; let rejected = false
    try { insertVoiceText(target, '识别结果') } catch { rejected = true }
    const unchanged = field.value === '他人修改'; field.remove()
    const password = document.createElement('input'); password.type = 'password'; document.body.append(password)
    const privateExcluded = captureVoiceTarget(password) === null; password.remove()
    const editable = document.createElement('div'); editable.contentEditable = 'true'; editable.textContent = '甲乙'; document.body.append(editable); editable.focus()
    const range = document.createRange(); range.setStart(editable.firstChild, 1); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    insertVoiceText(captureVoiceTarget(editable), '字'); const plainInserted = editable.textContent === '甲字乙'; editable.remove()
    return { rejected, unchanged, privateExcluded, plainInserted }
  })
  check(Object.values(insert).every(Boolean), 'stale edit rejection, password exclusion and plaintext contenteditable insertion')
  await page.getByRole('button', { name: '打开 AI 语音助手' }).click()
  await page.getByRole('dialog', { name: 'AI 语音助手' }).waitFor()
  await page.getByLabel('查询范围').selectOption('project:voice_fixture_project')
  await page.getByRole('textbox', { name: '向 AI 助手提问' }).fill('有多少问题等待验收？')
  await page.getByRole('button', { name: '发送问题' }).click()
  await page.getByText('当前项目有 2 个问题等待验收。', { exact: true }).waitFor()
  await page.getByText('手机模型使用了部分文字摘要；超出上下文长度的内容未全部送入模型。').waitFor()
  await page.waitForTimeout(200)
  const ask = calls.find(item => item.path === '/api/voice/ask'), speech = calls.find(item => item.path === '/api/voice/speech')
  check(ask?.json?.context.kind === 'project' && ask.json.context.id === 'voice_fixture_project', 'explicit permission-scoped context is sent')
  check(speech?.json?.text === '有两个问题等待验收。', 'speech uses server spokenAnswer, not guessed full response')
  uploadReply = '今日新增了多少问题？'
  await page.getByRole('button', { name: '用语音提问', exact: true }).click()
  await page.getByText('正在聆听', { exact: true }).waitFor(); await page.waitForTimeout(400)
  await page.getByRole('button', { name: '完成并识别' }).click()
  await page.getByText('今日新增了多少问题？', { exact: true }).waitFor()
  check(calls.filter(item => item.path === '/api/voice/ask').length === 2, 'voice question flows through transcription then account-scoped Q&A')
  await page.waitForTimeout(200)
  await page.screenshot({ path: 'output/playwright/voice-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  const geometry = await page.getByRole('dialog', { name: 'AI 语音助手' }).boundingBox()
  check(geometry.x >= 0 && geometry.x + geometry.width <= 390 && geometry.y >= 0 && geometry.y + geometry.height <= 844, 'mobile panel fits viewport')
  await page.screenshot({ path: 'output/playwright/voice-mobile.png' })
  askDelay = true
  await page.getByRole('textbox', { name: '向 AI 助手提问' }).fill('这是取消测试')
  await page.getByRole('button', { name: '发送问题' }).click()
  await page.getByText('正在读取所选数据并整理回答…').waitFor()
  await page.getByRole('button', { name: '取消处理', exact: true }).click()
  await page.waitForTimeout(1400)
  check(await page.locator('.fb-voice-exchange').count() === 2, 'canceled late answer must not append')
  await page.getByRole('button', { name: '关闭 AI 助手' }).click()
  await page.getByRole('button', { name: '打开 AI 语音助手' }).click()
  await page.evaluate(() => { window.__voiceQa.denyPermission = true })
  await page.getByRole('button', { name: '用语音提问', exact: true }).click()
  await page.getByText('未获得麦克风权限，请在地址栏允许麦克风后重试。').waitFor()
  check(await page.evaluate(() => window.__voiceQa.activeTracks) === 0, 'permission denial does not retain microphone resources')
  await page.getByRole('button', { name: '关闭识别结果' }).click()
  await page.evaluate(() => { window.__voiceQa.denyPermission = false; window.__voiceQa.deferPermission = true })
  await page.getByRole('button', { name: '用语音提问', exact: true }).click()
  await page.getByText('等待麦克风授权', { exact: true }).waitFor()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.evaluate(() => { window.__voiceQa.deferPermission = false; window.__voiceQa.resolvePermission() })
  await page.waitForTimeout(200)
  check(await page.evaluate(() => window.__voiceQa.activeTracks) === 0, 'cancel while permission is pending stops a late granted stream')
  await page.getByRole('button', { name: '关闭 AI 助手' }).click()
  const retained = await page.evaluate(() => ({ captures: window.__voiceQa.captures, activeTracks: window.__voiceQa.activeTracks, objectUrls: window.__voiceQa.urls.size }))
  check(retained.activeTracks === 0 && retained.objectUrls === 0, 'all microphone tracks and audio/worklet object URLs released')
  const uploads = calls.filter(item => item.path === '/api/voice/transcribe')
  check(uploads.every(item => item.bytes >= 8000 && item.bytes <= 640000 && item.bytes % 2 === 0), 'browser emits bounded signed16LE mono16k frames')
  const result = { result: failures.length ? 'FAIL' : 'PASS_BROWSER_FIXTURES', scope: 'actual Edge AudioContext + generated oscillator, real React canvas editor; mocked server/model replies; no human/phone microphone evidence', uploads: uploads.map(item => item.bytes), retained, checks: checkCount, failures }
  await page.evaluate(result => { window.__voiceUiResult = result }, result)
  console.log(JSON.stringify(result))
  if (failures.length) throw new Error(failures.join('; '))
  return result
}
