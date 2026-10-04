// Browser-only stand-in for the Electron bridge, so the UI can be developed and
// previewed with `npm run dev:web` in any browser. Never loaded inside Electron.
// Simulates a live download so progress UI can be checked without a real account.

import type { GamekinsApi } from '@shared/api'
import type { Account, DownloadJob, FreeGame, Game, GamePrefs, Settings } from '@shared/types'
import sample from './devMockData.json'

type Listener<T> = (v: T) => void
const GB = 1024 ** 3
const MB = 1024 ** 2

export function installDevMock(): void {
  // Local-only verification mode: block the sample artwork's remote URLs before mounting.
  if (new URLSearchParams(location.search).has('offline')) {
    const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')
    if (policy) policy.content = policy.content.replace('img-src \'self\' data: https:', 'img-src \'self\' data:')
  }
  const now = Date.now()
  // Preview flags: ?mock=signedout | loading | many (600 games) | empty
  const flag = new URLSearchParams(location.search).get('mock') ?? ''
  const prefs: Record<string, GamePrefs> = { 'epic:mock1': { favorite: true }, 'epic:mock3': { favorite: true } }
  // Library UI previews: a couple of user collections.
  prefs['epic:mock0'] = { collections: ['Story games'] }
  prefs['epic:mock2'] = { collections: ['Story games', 'Co-op night'] }

  let games: Game[] = sample.map((s, i) => ({
    key: `epic:mock${i}`,
    provider: 'epic',
    appName: `mock${i}`,
    title: s.title,
    namespace: 'ns',
    catalogItemId: `id${i}`,
    developer: s.developer,
    description: s.description,
    images: { tall: s.tall, wide: s.wide, thumb: s.tall },
    platforms: i === 9 ? ['Mac'] : ['Windows'],
    latestVersion: '1.0.2',
    canRunOffline: i % 2 === 0,
    requiresOwnershipToken: false,
    install:
      i < 5
        ? {
            path: `C:\\Games\\${s.title}`,
            version: i === 2 ? '1.0.1' : '1.0.2',
            executable: 'Game.exe',
            launchCommand: '',
            platform: 'Windows',
            sizeBytes: (8 + i * 7) * GB,
            source: i === 4 ? 'epic-launcher' : 'gamekins',
            installedAt: now
          }
        : undefined,
    updateAvailable: i === 2,
    playtimeSeconds: i < 4 ? (4 - i) * 7340 : 0,
    lastPlayed: i < 4 ? now - i * 86_400_000 * 1.5 : undefined,
    prefs: prefs[`epic:mock${i}`] ?? {},
    dlc:
      i === 0
        ? [
            { key: 'epic:dlc0a', appName: 'dlc0a', title: 'Season Pass', image: s.wide, installable: true, updateAvailable: false, install: { path: 'C:\\Games\\x', version: '1.0.2', executable: '', launchCommand: '', platform: 'Windows', sizeBytes: 2.1 * GB, source: 'gamekins', installedAt: now } },
            { key: 'epic:dlc0b', appName: 'dlc0b', title: 'Soundtrack', installable: true, updateAvailable: false },
            { key: 'epic:dlc0c', appName: 'dlc0c', title: 'Bonus Costume Pack', installable: false, updateAvailable: false }
          ]
        : []
  }))

  // Library UI previews: an EA-app managed title and a non-Epic program with its icon.
  const mockIcon =
    'data:image/svg+xml;base64,' +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#e2483d"/><path d="M9 8h9a6 6 0 0 1 0 12h-4v4H9z" fill="#fff"/></svg>')
  games.push(
    {
      ...games[7],
      key: 'epic:mockEA',
      appName: 'mockEA',
      title: 'Apex Arena Racing (EA)',
      thirdPartyManagedApp: 'the EA app',
      install: undefined,
      updateAvailable: false,
      playtimeSeconds: 0,
      lastPlayed: undefined,
      prefs: {},
      dlc: []
    },
    {
      key: 'local:mockemu',
      provider: 'local',
      appName: 'mockemu',
      title: 'Retro Emulator',
      namespace: '',
      catalogItemId: '',
      images: { thumb: mockIcon },
      platforms: ['Windows'],
      canRunOffline: true,
      requiresOwnershipToken: false,
      install: { path: 'C:\\Emulators\\RetroEmu\\retroemu.exe', version: '', executable: 'retroemu.exe', launchCommand: '', platform: 'Windows', sizeBytes: 0, source: 'local', installedAt: now - 5 * 86_400_000 },
      updateAvailable: false,
      playtimeSeconds: 5400,
      lastPlayed: now - 20 * 86_400_000,
      prefs: {},
      dlc: []
    }
  )
  if (flag === 'many') {
    const base = games
    games = Array.from({ length: 600 }, (_, n) => {
      const g = base[n % base.length]
      return n < base.length ? g : { ...g, key: `epic:many${n}`, appName: `many${n}`, title: `${g.title} ${Math.floor(n / base.length) + 1}`, dlc: [], prefs: {}, running: false }
    })
  }
  const allGames = games
  if (flag === 'loading' || flag === 'signedout' || flag === 'empty') games = []

  const job = (i: number, over: Partial<DownloadJob>): DownloadJob => ({
    id: `j${i}`,
    gameKey: allGames[i].key,
    title: allGames[i].title,
    image: allGames[i].images.wide,
    kind: 'install',
    state: 'queued',
    installPath: `C:\\Games\\${allGames[i].title}`,
    downloadedBytes: 0,
    totalDownloadBytes: 3.2 * GB,
    writtenBytes: 0,
    totalWriteBytes: 4 * GB,
    verifiedBytes: 0,
    totalVerifyBytes: 0,
    speedBps: 0,
    diskBps: 0,
    speedHistory: [],
    diskHistory: [],
    addedAt: now,
    ...over
  })

  let jobs: DownloadJob[] = [
    job(6, {
      state: 'downloading',
      downloadedBytes: 6.1 * GB,
      totalDownloadBytes: 14.2 * GB,
      writtenBytes: 9.4 * GB,
      totalWriteBytes: 21 * GB,
      speedHistory: Array.from({ length: 40 }, (_, i) => (30 + Math.sin(i / 4) * 8 + Math.random() * 6) * MB),
      diskHistory: Array.from({ length: 40 }, (_, i) => (55 + Math.cos(i / 5) * 12 + Math.random() * 8) * MB),
      currentFile: 'Content/Paks/pakchunk0-WindowsNoEditor.pak'
    }),
    job(8, {}),
    job(2, { kind: 'update', state: 'paused', downloadedBytes: 0.4 * GB, totalDownloadBytes: 1.1 * GB, writtenBytes: 0.6 * GB, totalWriteBytes: 1.5 * GB }),
    job(10, { state: 'error', error: 'HTTP 403 fetching chunk (CDN refused the request)' }),
    job(11, { state: 'done', finishedAt: now - 3_600_000, downloadedBytes: 2 * GB, totalDownloadBytes: 2 * GB, writtenBytes: 3 * GB, totalWriteBytes: 3 * GB })
  ]

  let settings: Settings = {
    installDir: 'C:\\Games',
    maxWorkers: 16,
    autoUpdate: true,
    launchViaEpicLauncher: false,
    importEpicLauncherInstalls: true,
    installPrerequisites: true,
    minimizeOnLaunch: false,
    bandwidthLimitMBps: 0,
    downloadsDuringGameplay: false,
    closeToTray: true,
    launchAtLogin: false
  }
  let accounts: Account[] = flag === 'signedout' ? [] : [{ provider: 'epic', id: 'me', displayName: 'PlayerOne' }]

  const freeGames: FreeGame[] = sample.slice(0, 3).map((s, i) => ({
    title: s.title,
    image: s.wide,
    url: 'https://store.epicgames.com/free-games',
    startDate: new Date(now - 86_400_000).toISOString(),
    endDate: new Date(now + (i + 2) * 86_400_000).toISOString(),
    current: i < 2
  }))

  const listeners = {
    library: new Set<Listener<Game[]>>(),
    downloads: new Set<Listener<DownloadJob[]>>(),
    accounts: new Set<Listener<Account[]>>()
  }
  const sub =
    <T>(set: Set<Listener<T>>) =>
    (cb: Listener<T>) => {
      set.add(cb)
      return () => set.delete(cb)
    }
  const emitGames = (): void => listeners.library.forEach((l) => l(games))
  if (flag === 'empty') jobs = []
  const emitJobs = (): void => listeners.downloads.forEach((l) => l(jobs))
  const patchGame = (key: string, fn: (g: Game) => Game): void => {
    games = games.map((g) => (g.key === key ? fn(g) : g))
    emitGames()
  }
  const patchJob = (id: string, fn: (j: DownloadJob) => DownloadJob): void => {
    jobs = jobs.map((j) => (j.id === id ? fn(j) : j))
    emitJobs()
  }
  const enqueue = (key: string, kind: DownloadJob['kind']): void => {
    if (jobs.some((j) => j.gameKey === key && !['done', 'cancelled', 'error'].includes(j.state))) return
    const i = games.findIndex((g) => g.key === key)
    if (i < 0) {
      const parent = games.find((g) => g.dlc.some((d) => d.key === key))
      const dlc = parent?.dlc.find((d) => d.key === key)
      if (!parent || !dlc) return
      jobs = [
        ...jobs.filter((j) => j.gameKey !== key),
        { ...job(games.indexOf(parent), { id: `j${Date.now()}`, kind }), gameKey: key, title: dlc.title, totalDownloadBytes: 0.3 * GB, totalWriteBytes: 0.5 * GB }
      ]
    } else jobs = [...jobs.filter((j) => j.gameKey !== key), job(i, { id: `j${Date.now()}`, kind })]
    emitJobs()
  }

  // Animate the active download.
  setInterval(() => {
    const active = jobs.find((j) => ['downloading', 'preparing', 'verifying'].includes(j.state))
    if (!active) {
      const next = jobs.find((j) => j.state === 'queued')
      if (next) patchJob(next.id, (j) => ({ ...j, state: 'downloading' }))
      return
    }
    const bps = (28 + Math.random() * 18) * MB
    const disk = bps * 1.4
    patchJob(active.id, (j) => {
      const downloaded = Math.min(j.totalDownloadBytes, j.downloadedBytes + bps)
      const written = Math.min(j.totalWriteBytes, j.writtenBytes + disk)
      const done = written >= j.totalWriteBytes
      if (done) {
        const g = games.find((x) => x.key === j.gameKey)
        const inst = { path: j.installPath, version: '1.0.2', executable: 'Game.exe', launchCommand: '', platform: 'Windows' as const, sizeBytes: j.totalWriteBytes, source: 'gamekins' as const, installedAt: Date.now() }
        if (!g) {
          const parent = games.find((x) => x.dlc.some((d) => d.key === j.gameKey))
          if (parent) patchGame(parent.key, (x) => ({ ...x, dlc: x.dlc.map((d) => (d.key === j.gameKey ? { ...d, install: inst } : d)) }))
        } else patchGame(g.key, (x) => ({
          ...x,
          updateAvailable: false,
          install: { path: j.installPath, version: '1.0.2', executable: 'Game.exe', launchCommand: '', platform: 'Windows', sizeBytes: j.totalWriteBytes, source: 'gamekins', installedAt: Date.now() }
        }))
      }
      return {
        ...j,
        state: done ? 'done' : 'downloading',
        finishedAt: done ? Date.now() : undefined,
        downloadedBytes: downloaded,
        writtenBytes: written,
        speedBps: done ? 0 : bps,
        diskBps: done ? 0 : disk,
        speedHistory: [...j.speedHistory, bps].slice(-60),
        diskHistory: [...j.diskHistory, disk].slice(-60)
      }
    })
  }, 1000)

  const noop = async (): Promise<void> => undefined

  const api: GamekinsApi = {
    app: {
      info: async () => ({
        version: '0.2.0-dev',
        platform: 'win32',
        providers: [
          { id: 'epic', name: 'Epic Games', available: true },
          { id: 'gog', name: 'GOG Galaxy', available: false },
          { id: 'ea', name: 'EA app', available: false },
          { id: 'ubisoft', name: 'Ubisoft Connect', available: false }
        ]
      }),
      openExternal: async (url) => void window.open(url, '_blank'),
      pickDirectory: async () => 'D:\\Games',
      quit: noop,
      pickFiles: async () => ['C:\\Games\\MyGame\\MyGame.exe'],
      listPrograms: async () => [
        { name: 'Minecraft Launcher', path: 'C:\\XboxGames\\Minecraft Launcher\\MinecraftLauncher.exe' },
        { name: 'osu!', path: 'C:\\Users\\me\\AppData\\Local\\osu!\\osu!.exe' },
        { name: 'RetroArch', path: 'C:\\RetroArch\\retroarch.exe' },
        { name: 'Battle.net', path: 'C:\\Program Files (x86)\\Battle.net\\Battle.net Launcher.exe' },
        { name: 'Retro Emulator', path: 'C:\\Emulators\\RetroEmu\\retroemu.exe', icon: mockIcon }
      ],
      storage: async () => [
        {
          root: 'C:\\',
          totalBytes: 1000 * GB,
          freeBytes: 412 * GB,
          games: games
            .filter((g) => g.install && g.provider !== 'local')
            .map((g) => ({ key: g.key, title: g.title, path: g.install!.path, sizeBytes: g.install!.sizeBytes }))
            .sort((a, b) => b.sizeBytes - a.sizeBytes)
        },
        { root: 'D:\\', totalBytes: 2000 * GB, freeBytes: 1500 * GB, games: [] }
      ]
    },
    accounts: {
      list: async () => accounts,
      login: async () => {
        accounts = [{ provider: 'epic', id: 'me', displayName: 'PlayerOne' }]
        if (!games.length && flag !== 'empty') {
          games = allGames
          emitGames()
        }
        listeners.accounts.forEach((l) => l(accounts))
        return accounts[0]
      },
      logout: async () => {
        accounts = []
        listeners.accounts.forEach((l) => l(accounts))
      }
    },
    library: {
      get: async () => games,
      refresh: async () => {
        await new Promise((r) => setTimeout(r, 800))
        return games
      },
      freeGames: async () => freeGames
    },
    games: {
      plan: async (key, base) => ({
        installPath: `${base ?? settings.installDir}\\${games.find((g) => g.key === key)?.title}`,
        downloadBytes: 12.4 * GB,
        installBytes: 19.8 * GB,
        freeBytes: 412 * GB,
        version: '1.0.2'
      }),
      install: async (key) => enqueue(key, 'install'),
      importFolder: async (key) => enqueue(key, 'repair'),
      update: async (key) => enqueue(key, 'update'),
      repair: async (key) => enqueue(key, 'repair'),
      uninstall: async (key) => {
        const parent = games.find((g) => g.dlc.some((d) => d.key === key))
        if (parent) patchGame(parent.key, (g) => ({ ...g, dlc: g.dlc.map((d) => (d.key === key ? { ...d, install: undefined } : d)) }))
        else patchGame(key, (g) => ({ ...g, install: undefined, updateAvailable: false }))
      },
      launch: async (key) => {
        patchGame(key, (g) => ({ ...g, running: true, lastPlayed: Date.now() }))
        setTimeout(() => patchGame(key, (g) => ({ ...g, running: false, playtimeSeconds: g.playtimeSeconds + 600 })), 20000)
      },
      stop: async (key) => patchGame(key, (g) => ({ ...g, running: false })),
      openFolder: noop,
      editCollections: async (edit) => {
        for (const key of edit.gameKeys) if (!games.some((g) => g.key === key)) throw new Error('Unknown game')
        const same = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
        const changed: Game[] = []
        games = games.map((g) => {
          if (!['rename', 'delete'].includes(edit.operation) && !edit.gameKeys.includes(g.key)) return g
          const before = g.prefs.collections ?? []
          const has = before.some((n) => same(n, edit.name))
          let next = before
          if (edit.operation === 'add' && !has) next = [...before, edit.name]
          if (edit.operation === 'remove' || edit.operation === 'delete') next = before.filter((n) => !same(n, edit.name))
          if (edit.operation === 'rename' && has) next = [...before.filter((n) => !same(n, edit.name) && !same(n, edit.replacement!)), edit.replacement!]
          if (JSON.stringify(next) === JSON.stringify(before)) return g
          const updated = { ...g, prefs: { ...g.prefs, collections: next } }
          changed.push(updated)
          return updated
        })
        emitGames()
        return changed
      },
      setPrefs: async (key, patch) => patchGame(key, (g) => ({ ...g, prefs: { ...g.prefs, ...patch } })),
      moveInstall: async (key, baseDir) => {
        await new Promise((r) => setTimeout(r, 1500))
        patchGame(key, (g) => (g.install ? { ...g, install: { ...g.install, path: baseDir + '/' + g.title } } : g))
      },
      addLocal: async (paths) => {
        const keys: string[] = []
        for (const p of paths) {
          const id = Math.random().toString(36).slice(2, 10)
          const title = p.split(/[\\/]/).pop()!.replace(/\.(exe|lnk|app)$/i, '')
          keys.push(`local:${id}`)
          games = [
            ...games,
            {
              key: `local:${id}`,
              provider: 'local',
              appName: id,
              title,
              namespace: '',
              catalogItemId: '',
              description: p,
              images: {},
              platforms: ['Windows'],
              canRunOffline: true,
              requiresOwnershipToken: false,
              install: { path: p, version: '', executable: title + '.exe', launchCommand: '', platform: 'Windows', sizeBytes: 0, source: 'local', installedAt: Date.now() },
              updateAvailable: false,
              playtimeSeconds: 0,
              prefs: {},
              dlc: []
            }
          ]
        }
        emitGames()
        return keys
      },
      setArtwork: async (key, kind, filePath) =>
        patchGame(key, (g) => ({ ...g, images: { ...g.images, [kind]: filePath ? sample[3].tall : undefined } })),
      createShortcut: noop,
      details: async (key) => {
        await new Promise((r) => setTimeout(r, 400))
        const g = games.find((x) => x.key === key)
        if (!g || g.provider === 'local') return null
        const i = Math.max(0, games.indexOf(g)) % sample.length
        const shots = sample.filter((_, k) => k !== i).slice(0, 6)
        return {
          fetchedAt: Date.now(),
          title: g.title,
          steam: {
            appId: 100000 + i,
            url: 'https://store.steampowered.com/',
            name: g.title,
            shortDescription: g.description,
            about: `${g.description ?? ''}\n\nExplore a hand-crafted world, master a deep combat system and uncover secrets across dozens of hours of adventure.\n\n• Over 40 unique areas to explore\n• Dozens of weapons and abilities\n• Full controller support`,
            genres: ['Action', 'Adventure', 'Indie', 'RPG'].slice(0, 2 + (i % 3)),
            features: ['Single-player', 'Steam Achievements', 'Full controller support', 'Steam Cloud', 'Family Sharing'],
            developers: [g.developer ?? 'Indie Studio'],
            publishers: ['Mock Publishing'],
            releaseDate: `Aug ${8 + i}, 20${17 + (i % 8)}`,
            metacritic: i % 3 === 0 ? undefined : { score: 72 + i, url: 'https://www.metacritic.com/' },
            reviews: { summary: ['Very Positive', 'Mostly Positive', 'Overwhelmingly Positive'][i % 3], positive: 9000 + i * 311, total: 10000 + i * 350 },
            screenshots: shots.map((s) => ({ thumb: s.wide, full: s.wide })),
            trailers: [{ name: `${g.title} — Launch Trailer`, thumb: shots[0]?.wide ?? sample[0].wide }],
            art: {},
            controllerSupport: 'full',
            requirements: {
              minimum: 'OS: Windows 10 64-bit\nProcessor: Intel Core i5-4460\nMemory: 8 GB RAM\nGraphics: GeForce GTX 960\nStorage: 20 GB available space',
              recommended: 'OS: Windows 11 64-bit\nProcessor: Intel Core i7-8700\nMemory: 16 GB RAM\nGraphics: GeForce RTX 2060\nStorage: 20 GB SSD'
            },
            achievements: 30 + i
          },
          hltb: { id: 4000 + i, url: 'https://howlongtobeat.com/', name: g.title, mainHours: 5.5 + i, extraHours: 9 + i * 1.5, completionistHours: 14 + i * 2.5 }
        }
      }
    },
    downloads: {
      list: async () => jobs,
      pause: async (id) => patchJob(id, (j) => ({ ...j, state: 'paused', speedBps: 0, diskBps: 0 })),
      resume: async (id) => {
        jobs = jobs.map((j) => (['downloading', 'preparing'].includes(j.state) && j.id !== id ? { ...j, state: 'queued', speedBps: 0 } : j))
        patchJob(id, (j) => ({ ...j, state: 'downloading', error: undefined }))
      },
      cancel: async (id) => {
        jobs = jobs.filter((j) => j.id !== id)
        emitJobs()
      },
      move: async (id, delta) => {
        const i = jobs.findIndex((j) => j.id === id)
        const k = Math.max(0, Math.min(jobs.length - 1, i + delta))
        const copy = [...jobs]
        const [it] = copy.splice(i, 1)
        copy.splice(k, 0, it)
        jobs = copy
        emitJobs()
      },
      clearFinished: async () => {
        jobs = jobs.filter((j) => !['done', 'cancelled'].includes(j.state))
        emitJobs()
      }
    },
    settings: {
      get: async () => settings,
      set: async (patch) => (settings = { ...settings, ...patch })
    },
    on: {
      library: sub(listeners.library),
      libraryProgress: (cb) => {
        if (flag !== 'loading') return () => undefined
        // Simulate the first library load streaming in.
        let done = 0
        const total = allGames.length * 24
        cb({ loading: true, done: 0, total: 0 })
        const t = setInterval(() => {
          done = Math.min(total, done + 9)
          cb({ loading: done < total, done, total })
          if (done >= total) {
            clearInterval(t)
            games = allGames
            emitGames()
          }
        }, 150)
        return () => clearInterval(t)
      },
      downloads: sub(listeners.downloads),
      accounts: sub(listeners.accounts),
      toast: () => () => undefined,
      navigate: () => () => undefined
    }
  }
  window.gamekins = api
}
