import React, { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000'
const AVAILABLE_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'facebook', 'threads', 'linkedin', 'pinterest', 'x'] as const

type AuthUser = {
  id: number
  username: string
  createdAt: string
}

export function App() {
  const [fileUrl, setFileUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [silenceOn, setSilenceOn] = useState(false)
  const [silenceDb, setSilenceDb] = useState(-45)
  const [silenceMin, setSilenceMin] = useState(0.4)

  const [auto916On, setAuto916On] = useState(false)
  const [format, setFormat] = useState<'9:16' | '1:1'>('9:16')
  const [blur, setBlur] = useState(20)

  const [textOn, setTextOn] = useState(false)
  const [text, setText] = useState('Mi título')
  const [position, setPosition] = useState('bc')
  const [fontSize, setFontSize] = useState(48)
  const [color, setColor] = useState('#ffffff')
  const [bgColor, setBgColor] = useState('')
  const [align, setAlign] = useState<'left'|'center'|'right'>('center')

  const disabled = useMemo(() => !(file || fileUrl), [file, fileUrl])

  const [token, setToken] = useState(() => localStorage.getItem('auth_token') || '')
  const [checkingSession, setCheckingSession] = useState(() => Boolean(localStorage.getItem('auth_token')))
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [authMode, setAuthMode] = useState<'login'|'register'>('login')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const [profile, setProfile] = useState<any | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)

  const [connectUrl, setConnectUrl] = useState<string | null>(null)
  const [connectLoading, setConnectLoading] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const [platformSelections, setPlatformSelections] = useState<Record<string, boolean>>(() => (
    Object.fromEntries(AVAILABLE_PLATFORMS.map(p => [p, false])) as Record<string, boolean>
  ))
  const [publishTitle, setPublishTitle] = useState('Mi video editado')
  const [publishDescription, setPublishDescription] = useState('')
  const [publishSchedule, setPublishSchedule] = useState('')
  const [publishFacebookPageId, setPublishFacebookPageId] = useState('')
  const [publishAsync, setPublishAsync] = useState(true)
  const [uploadingToSocial, setUploadingToSocial] = useState(false)
  const [uploadResult, setUploadResult] = useState<any | null>(null)
  const [socialError, setSocialError] = useState<string | null>(null)

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file)
      setPreviewUrl(url)
      return () => URL.revokeObjectURL(url)
    }
  }, [file])

  useEffect(() => {
    if (!file && fileUrl) setPreviewUrl(fileUrl)
  }, [file, fileUrl])

  const apiFetch = useCallback((path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers || {})
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return fetch(`${API_BASE}${path}`, { ...init, headers })
  }, [token])

  useEffect(() => {
    let cancelled = false
    if (!token) {
      setCheckingSession(false)
      setCurrentUser(null)
      return
    }
    setCheckingSession(true)
    ;(async () => {
      try {
        const res = await apiFetch('/api/auth/me')
        if (!res.ok) throw new Error('unauthorized')
        const data = await res.json()
        if (!cancelled) {
          setCurrentUser(data.user)
        }
      } catch (err) {
        if (!cancelled) {
          localStorage.removeItem('auth_token')
          setToken('')
          setCurrentUser(null)
        }
      } finally {
        if (!cancelled) setCheckingSession(false)
      }
    })()
    return () => { cancelled = true }
  }, [token, apiFetch])

  const loadProfile = useCallback(async () => {
    if (!token || !currentUser) return
    setProfileLoading(true)
    setProfileError(null)
    try {
      const res = await apiFetch('/api/social/profile')
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'No se pudo obtener el perfil')
      setProfile(data.profile)
    } catch (err: any) {
      setProfileError(err?.message || 'No se pudo obtener el perfil de Upload-Post')
    } finally {
      setProfileLoading(false)
    }
  }, [apiFetch, currentUser, token])

  useEffect(() => {
    if (currentUser && token) {
      loadProfile()
    }
  }, [currentUser, token, loadProfile])

  const selectedPlatforms = useMemo(
    () => AVAILABLE_PLATFORMS.filter(platform => platformSelections[platform]),
    [platformSelections]
  )

  const publishDisabled = useMemo(
    () => !currentUser || selectedPlatforms.length === 0 || (!file && !fileUrl) || uploadingToSocial,
    [currentUser, selectedPlatforms, file, fileUrl, uploadingToSocial]
  )

  const connectedAccounts = useMemo(() => collectConnectedAccounts(profile), [profile])
  const profilePlan = profile?.plan ?? profile?.profile?.plan ?? null
  const profileLimit = profile?.limit ?? profile?.profile?.limit ?? null

  function persistToken(value: string) {
    if (value) {
      localStorage.setItem('auth_token', value)
    } else {
      localStorage.removeItem('auth_token')
    }
    setToken(value)
  }

  async function handleVideoResponse(res: Response, downloadName = 'output.mp4') {
    const ct = res.headers.get('content-type') || ''
    if (res.ok && ct.includes('video')) {
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      setPreviewUrl(url)
      const a = document.createElement('a')
      a.href = url
      a.download = downloadName
      document.body.appendChild(a)
      a.click()
      a.remove()
      return true
    }
    return false
  }

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!authUsername.trim() || !authPassword.trim()) {
      setAuthError('Ingresa usuario y contraseña')
      return
    }
    setAuthLoading(true)
    setAuthError(null)
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register'
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authUsername.trim(), password: authPassword })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'No se pudo completar la solicitud')
      persistToken(data.token)
      setCurrentUser(data.user)
      setProfile(null)
      setAuthUsername('')
      setAuthPassword('')
      setCheckingSession(false)
    } catch (err: any) {
      setAuthError(err?.message || 'Error de autenticación')
    } finally {
      setAuthLoading(false)
    }
  }

  function handleLogout() {
    persistToken('')
    setCurrentUser(null)
    setProfile(null)
    setConnectUrl(null)
  }

  async function handleGenerateConnectUrl() {
    if (!currentUser) return
    setConnectLoading(true)
    setConnectError(null)
    try {
      const res = await apiFetch('/api/social/connect-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUrl: window.location.origin })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'No se pudo generar el enlace')
      const url = data.access_url || data.url || null
      setConnectUrl(url)
      if (url) {
        window.open(url, '_blank', 'noopener')
      }
    } catch (err: any) {
      setConnectError(err?.message || 'Error generando enlace de conexión')
    } finally {
      setConnectLoading(false)
    }
  }

  const refreshProfile = useCallback(() => {
    loadProfile()
  }, [loadProfile])

  function resetUploadFeedback() {
    setSocialError(null)
    setUploadResult(null)
  }

  async function handlePublish() {
    if (!currentUser) {
      setSocialError('Inicia sesión para publicar en redes')
      return
    }
    if (selectedPlatforms.length === 0) {
      setSocialError('Selecciona al menos una plataforma')
      return
    }
    if (!file && !fileUrl) {
      setSocialError('Selecciona un archivo o proporciona una URL de video')
      return
    }
    resetUploadFeedback()
    setUploadingToSocial(true)
    try {
      const scheduleIso = publishSchedule ? new Date(publishSchedule).toISOString() : undefined
      const extras: Record<string, unknown> = {}
      if (publishFacebookPageId.trim()) extras.facebook_page_id = publishFacebookPageId.trim()

      let res: Response
      if (file) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('title', publishTitle.trim() || 'Mi video')
        fd.append('platforms', JSON.stringify(selectedPlatforms))
        if (publishDescription.trim()) fd.append('description', publishDescription.trim())
        if (scheduleIso) fd.append('scheduled_date', scheduleIso)
        fd.append('async_upload', publishAsync ? 'true' : 'false')
        if (Object.keys(extras).length) fd.append('extraFields', JSON.stringify(extras))
        res = await apiFetch('/api/social/upload-video', {
          method: 'POST',
          body: fd
        })
      } else {
        const payload: Record<string, unknown> = {
          fileUrl,
          platforms: selectedPlatforms,
          title: publishTitle.trim() || 'Mi video'
        }
        if (publishDescription.trim()) payload.description = publishDescription.trim()
        if (scheduleIso) payload.scheduleDate = scheduleIso
        if (typeof publishAsync === 'boolean') payload.asyncUpload = publishAsync
        if (Object.keys(extras).length) payload.extraFields = extras
        res = await apiFetch('/api/social/upload-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
      }
      const text = await res.text()
      let parsed: any
      try {
        parsed = text ? JSON.parse(text) : {}
      } catch {
        parsed = text
      }
      if (!res.ok) {
        throw new Error(typeof parsed === 'string' ? parsed : parsed?.error || 'No se pudo publicar en redes')
      }
      setUploadResult(parsed)
    } catch (err: any) {
      setSocialError(err?.message || 'No se pudo publicar en redes sociales')
    } finally {
      setUploadingToSocial(false)
    }
  }

  function handlePlatformToggle(platform: string) {
    setPlatformSelections(prev => ({ ...prev, [platform]: !prev[platform] }))
  }

  async function runJob() {
    if (!(file || fileUrl)) return

    if (file) {
      if (silenceOn) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('silenceDb', String(silenceDb))
        fd.append('minSilenceSec', String(silenceMin))
        const res = await apiFetch('/api/ffmpeg/jobs/silence-cutter', { method: 'POST', body: fd })
        const handled = await handleVideoResponse(res)
        if (!handled) alert('Error procesando silencio')
        return
      }
      if (auto916On) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('blur', String(blur))
        fd.append('format', String(format))
        const res = await apiFetch('/api/ffmpeg/jobs/auto-916', { method: 'POST', body: fd })
        const handled = await handleVideoResponse(res)
        if (!handled) alert('Error procesando Auto 9:16')
        return
      }
      if (textOn) {
        if (!text.trim()) { alert('Escribe un texto para el overlay'); return }
        const fd = new FormData()
        fd.append('file', file)
        fd.append('text', text)
        fd.append('position', position)
        fd.append('fontSize', String(fontSize))
        fd.append('color', color)
        if (bgColor) fd.append('bgColor', bgColor)
        const res = await apiFetch('/api/ffmpeg/jobs/text-overlay', { method: 'POST', body: fd })
        const handled = await handleVideoResponse(res)
        if (!handled) alert('Error procesando Texto fijo')
        return
      }
    }

    if (silenceOn) {
      await apiFetch('/api/ffmpeg/jobs/silence-cutter', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUrl, silenceDb, minSilenceSec: silenceMin })
      })
    } else if (auto916On) {
      await apiFetch('/api/ffmpeg/jobs/auto-916', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUrl, blur, format })
      })
    } else if (textOn) {
      alert('Texto fijo requiere subir un archivo de video')
    }
    alert('Job enviado. Revisa logs del API para estado.')
  }

  if (checkingSession) {
    return (
      <div className="authWrapper">
        <div className="authCard">
          <h2>Verificando sesión...</h2>
        </div>
      </div>
    )
  }

  if (!currentUser) {
    return (
      <div className="authWrapper">
        <form className="authCard" onSubmit={handleAuthSubmit}>
          <h2>{authMode === 'login' ? 'Inicia sesión' : 'Crea tu cuenta'}</h2>
          <p className="authSubtitle">Accede para conectar tus redes sociales y publicar directamente desde el editor.</p>
          {authError && <div className="errorMessage">{authError}</div>}
          <label className="authLabel">
            Usuario
            <input className="authInput" value={authUsername} onChange={e => setAuthUsername(e.target.value)} placeholder="tu_usuario" autoComplete="username" />
          </label>
          <label className="authLabel">
            Contraseña
            <input className="authInput" type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="••••••" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          <button className="authButton" type="submit" disabled={authLoading}>
            {authLoading ? 'Procesando...' : authMode === 'login' ? 'Entrar' : 'Registrarme'}
          </button>
          <div className="authToggle">
            {authMode === 'login' ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?'}
            <button type="button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')} className="linkButton">
              {authMode === 'login' ? 'Crear una cuenta' : 'Inicia sesión'}
            </button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="sidebar">
        <section className="card card--compact headerCard">
          <div className="userHeader">
            <div>
              <div className="userGreeting">Hola, {currentUser.username}</div>
              <div className="userMeta">Miembro desde {new Date(currentUser.createdAt).toLocaleDateString()}</div>
            </div>
            <button className="secondaryButton" type="button" onClick={handleLogout}>Cerrar sesión</button>
          </div>
        </section>

        <div className="steps">
          <StepCard
            step="01"
            title="Fuente del video"
            description="Sube un archivo o pega una URL pública. Esto alimenta tanto el editor como la publicación."
          >
            <label className="authLabel">
              URL pública
              <input className="authInput" placeholder="https://mi-bucket/video.mp4" value={fileUrl} onChange={e => setFileUrl(e.target.value)} />
            </label>
            <label className="authLabel">
              Archivo local
              <input className="fileInput" type="file" accept="video/*" onChange={e => setFile(e.target.files?.[0] || null)} />
            </label>
            <div className="hintText">Consejo: si subes un archivo, úsalo también para publicar si la URL queda vacía.</div>
          </StepCard>

          <StepCard
            step="02"
            title="Pulir video"
            description="Opcional: aplica presets rápidos antes de publicar."
            footer={
              <div className="stepFooterActions">
                <button className="ghostButton" type="button" onClick={runJob} disabled={disabled}>
                  Procesar copia con Upload-Post
                </button>
              </div>
            }
          >
            <div className={`featureBlock ${silenceOn ? 'featureBlock--active' : ''}`}>
              <label className="featureHeader">
                <input className="checkbox" type="checkbox" checked={silenceOn} onChange={e => setSilenceOn(e.target.checked)} />
                <div>
                  <div className="featureTitle">Quitar silencios</div>
                  <div className="featureSubtitle">Recorta pausas largas y mantiene el ritmo.</div>
                </div>
              </label>
              <div className="featureControls">
                <div className="controlRow">
                  <span className="controlLabel">Umbral (dB): {silenceDb}</span>
                  <input className="range" type="range" min={-80} max={-10} step={1} value={silenceDb} onChange={e => setSilenceDb(Number(e.target.value))} />
                </div>
                <div className="controlRow">
                  <span className="controlLabel">Duración mínima (s): {silenceMin.toFixed(2)}</span>
                  <input className="range" type="range" min={0.1} max={2} step={0.1} value={silenceMin} onChange={e => setSilenceMin(Number(e.target.value))} />
                </div>
              </div>
            </div>

            <div className={`featureBlock ${auto916On ? 'featureBlock--active' : ''}`}>
              <label className="featureHeader">
                <input className="checkbox" type="checkbox" checked={auto916On} onChange={e => setAuto916On(e.target.checked)} />
                <div>
                  <div className="featureTitle">Auto 9:16</div>
                  <div className="featureSubtitle">Rellena el fondo con blur para vertical o cuadrado.</div>
                </div>
              </label>
              <div className="featureControls">
                <div className="controlRow">
                  <span className="controlLabel">Formato</span>
                  <select className="select" value={format} onChange={e => setFormat(e.target.value as any)}>
                    <option value="9:16">9:16</option>
                    <option value="1:1">1:1</option>
                  </select>
                </div>
                <div className="controlRow">
                  <span className="controlLabel">Blur: {blur}</span>
                  <input className="range" type="range" min={0} max={60} step={1} value={blur} onChange={e => setBlur(Number(e.target.value))} />
                </div>
              </div>
            </div>

            <div className={`featureBlock ${textOn ? 'featureBlock--active' : ''}`}>
              <label className="featureHeader">
                <input className="checkbox" type="checkbox" checked={textOn} onChange={e => setTextOn(e.target.checked)} />
                <div>
                  <div className="featureTitle">Texto fijo</div>
                  <div className="featureSubtitle">Superpone un título o CTA en el video.</div>
                </div>
              </label>
              <div className="featureControls">
                <div className="controlRow">
                  <span className="controlLabel">Texto</span>
                  <input className="textInput" placeholder="Texto" value={text} onChange={e => setText(e.target.value)} />
                </div>
                <div className="controlRow">
                  <span className="controlLabel">Posición</span>
                  <select className="select" value={position} onChange={e => setPosition(e.target.value)}>
                    <option value="tl">Arriba izq</option><option value="tc">Arriba centro</option><option value="tr">Arriba der</option>
                    <option value="ml">Medio izq</option><option value="mc">Medio centro</option><option value="mr">Medio der</option>
                    <option value="bl">Abajo izq</option><option value="bc">Abajo centro</option><option value="br">Abajo der</option>
                  </select>
                </div>
                <div className="controlRow">
                  <span className="controlLabel">Tamaño: {fontSize}</span>
                  <input className="range" type="range" min={16} max={120} step={2} value={fontSize} onChange={e => setFontSize(Number(e.target.value))} />
                </div>
                <div className="controlRow">
                  <span className="controlLabel">Color</span>
                  <input className="color" type="color" value={color} onChange={e => setColor(e.target.value)} />
                </div>
                <div className="controlRow">
                  <span className="controlLabel">Fondo opcional</span>
                  <input className="textInput" type="text" placeholder="#00000080" value={bgColor} onChange={e => setBgColor(e.target.value)} />
                </div>
                <div className="controlRow">
                  <span className="controlLabel">Alineación</span>
                  <select className="select" value={align} onChange={e => setAlign(e.target.value as any)}>
                    <option value="left">Izq</option>
                    <option value="center">Centro</option>
                    <option value="right">Der</option>
                  </select>
                </div>
              </div>
            </div>
          </StepCard>

          <StepCard
            step="03"
            title="Conecta tus redes"
            description="Abre el portal de Upload-Post, vincula cuentas y consulta el estado."
            footer={
              <>
                <div className="stepFooterActions">
                  <button className="button" type="button" onClick={handleGenerateConnectUrl} disabled={connectLoading}>
                    {connectLoading ? 'Generando...' : 'Abrir portal de conexión'}
                  </button>
                  <button className="linkButton" type="button" onClick={refreshProfile}>Refrescar conexiones</button>
                </div>
                {connectUrl && (
                  <label className="authLabel">
                    URL temporal generada
                    <input className="authInput" value={connectUrl} readOnly onFocus={e => e.currentTarget.select()} />
                  </label>
                )}
              </>
            }
          >
            <div className="statsRow">
              <div className="stat">
                <span className="statLabel">Plan</span>
                <strong>{profilePlan || 'Sincronizando...'}</strong>
              </div>
              {profileLimit && (
                <div className="stat">
                  <span className="statLabel">Perfiles</span>
                  <strong>{profileLimit}</strong>
                </div>
              )}
            </div>
            {profileError && <div className="errorMessage">{profileError}</div>}
            {profileLoading && <div className="hintText">Actualizando conexiones...</div>}
            {!profileLoading && connectedAccounts.length === 0 && !profileError && (
              <div className="hintText">Aún no hay redes conectadas.</div>
            )}
            {connectedAccounts.length > 0 && (
              <div className="chipList">
                {connectedAccounts.map(item => (
                  <span key={item.platform} className="chip">
                    <span className="chipPlatform">{item.platform}</span>
                    <span>{item.label}</span>
                  </span>
                ))}
              </div>
            )}
          </StepCard>

          <StepCard
            step="04"
            title="Configura la publicación"
            description="Elige plataformas, copia y horario. Upload-Post hará el resto."
            footer={
              <>
                {socialError && <div className="errorMessage">{socialError}</div>}
                <div className="stepFooterActions">
                  <button className="button" type="button" onClick={handlePublish} disabled={publishDisabled}>
                    {uploadingToSocial ? 'Publicando...' : 'Publicar en redes conectadas'}
                  </button>
                </div>
                {uploadResult && (
                  <details className="uploadResult" open>
                    <summary>Respuesta Upload-Post</summary>
                    <pre>{JSON.stringify(uploadResult, null, 2)}</pre>
                  </details>
                )}
              </>
            }
          >
            <label className="authLabel">
              Título
              <input className="authInput" value={publishTitle} onChange={e => setPublishTitle(e.target.value)} placeholder="Título para todas las plataformas" />
            </label>
            <label className="authLabel">
              Descripción (opcional)
              <textarea className="authTextarea" value={publishDescription} onChange={e => setPublishDescription(e.target.value)} placeholder="Texto extendido para plataformas que lo soportan" />
            </label>
            <div className="gridTwo">
              <label className="authLabel">
                Programar (UTC)
                <input className="authInput" type="datetime-local" value={publishSchedule} onChange={e => setPublishSchedule(e.target.value)} />
              </label>
              <label className="authLabel">
                Facebook Page ID
                <input className="authInput" value={publishFacebookPageId} onChange={e => setPublishFacebookPageId(e.target.value)} placeholder="Opcional" />
              </label>
            </div>
            <label className="toggleRow">
              <input type="checkbox" checked={publishAsync} onChange={e => setPublishAsync(e.target.checked)} />
              <span>Procesar como job asíncrono (recomendado para videos largos)</span>
            </label>
            <div className="platformGrid platformGrid--compact">
              {AVAILABLE_PLATFORMS.map(platform => (
                <label key={platform} className={`platformOption ${platformSelections[platform] ? 'platformOption--active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={platformSelections[platform]}
                    onChange={() => handlePlatformToggle(platform)}
                  />
                  <span>{platform}</span>
                </label>
              ))}
            </div>
            <div className="selectionSummary">
              <span className="selectionLabel">Plataformas seleccionadas</span>
              {selectedPlatforms.length ? (
                <div className="chipList">
                  {selectedPlatforms.map(p => (
                    <span key={p} className="chip chip--small">{p}</span>
                  ))}
                </div>
              ) : (
                <span className="hintText">Elige al menos una plataforma para habilitar la publicación.</span>
              )}
            </div>
          </StepCard>
        </div>
      </div>

      <div className="previewColumn">
        <div className="previewCard">
          <div className="previewTitle">Vista previa rápida</div>
          <div className="previewWrap">
            <div className="preview">
              {previewUrl && (
                <video className="previewVideo" src={previewUrl} controls muted loop />)
              }
              {[1,2].map(i => (
                <React.Fragment key={i}>
                  <div className="gridLineV" style={{ left: `${(i * 100) / 3}%` }} />
                  <div className="gridLineH" style={{ top: `${(i * 100) / 3}%` }} />
                </React.Fragment>
              ))}
              {textOn && (
                <div className="overlayText" style={{ color, fontSize, left: posToXY(position).x, top: posToXY(position).y, textAlign: align }}>
                  {text}
                </div>
              )}
            </div>
          </div>
        </div>

        <section className="card infoCard">
          <h3>Resumen</h3>
          <div className="infoGrid">
            <div className="infoRow">
              <span>Fuente actual</span>
              <strong>{file ? file.name : (fileUrl ? 'Desde URL' : 'Sin definir')}</strong>
            </div>
            <div className="infoRow">
              <span>Plataformas</span>
              <strong>{selectedPlatforms.length ? selectedPlatforms.join(', ') : 'Ninguna'}</strong>
            </div>
            <div className="infoRow">
              <span>Fecha programada</span>
              <strong>{publishSchedule ? new Date(publishSchedule).toLocaleString() : 'Publicación inmediata'}</strong>
            </div>
            <div className="infoRow">
              <span>Modo de subida</span>
              <strong>{publishAsync ? 'Asíncrono' : 'Sincrónico'}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function posToXY(pos: string): { x: string; y: string } {
  const map: Record<string,{x:string;y:string}> = {
    tl: { x: '10%', y: '10%' }, tc: { x: '50%', y: '10%' }, tr: { x: '90%', y: '10%' },
    ml: { x: '10%', y: '50%' }, mc: { x: '50%', y: '50%' }, mr: { x: '90%', y: '50%' },
    bl: { x: '10%', y: '90%' }, bc: { x: '50%', y: '90%' }, br: { x: '90%', y: '90%' }
  }
  return map[pos] || map.bc
}

function collectConnectedAccounts(profileData: any): Array<{ platform: string; label: string }> {
  if (!profileData) return []
  const source = profileData.social_accounts || profileData.profile?.social_accounts
  if (!source || typeof source !== 'object') return []
  return Object.entries(source)
    .map(([platform, value]) => {
      if (!value) return null
      if (typeof value === 'string') {
        return { platform, label: value }
      }
      if (typeof value === 'object') {
        const obj = value as Record<string, any>
        const label = obj.display_name || obj.username || obj.name || obj.vanityName || obj.id || 'Conectado'
        return { platform, label: String(label) }
      }
      return { platform, label: 'Conectado' }
    })
    .filter(Boolean) as Array<{ platform: string; label: string }>
}

type StepCardProps = {
  step: string
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
}

function StepCard({ step, title, description, children, footer }: StepCardProps) {
  return (
    <section className="card stepCard">
      <div className="stepHeader">
        <span className="stepBadge">{step}</span>
        <div>
          <h3 className="stepTitle">{title}</h3>
          {description && <p className="stepDescription">{description}</p>}
        </div>
      </div>
      <div className="stepBody">{children}</div>
      {footer && <div className="stepFooter">{footer}</div>}
    </section>
  )
}
