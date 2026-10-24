import { useLayoutEffect, useRef } from "react"

interface Star {
  x: number
  y: number
  phase: number
  speed: number
}

interface Scene {
  cols: number
  rows: number
  /** The still scene: the sky, the dish and the ground, as image data. Stars draw over it. */
  still: Uint8ClampedArray
  stars: Star[]
}

/** The canvas, with the stop function of the art while it runs, and the seed of its scene. */
type ArtCanvas = HTMLCanvasElement & { stopArt?: () => void; artSeed?: number }

/**
 * Starts the art on `canvas` and returns the function that stops it. A call while
 * the art runs returns the same function.
 *
 * The page also runs this function from its source text in an inline script (see
 * `PixelDishArt`), so the body must not use any name from outside it. Types are
 * fine: they do not exist at run time.
 */
function startDishArt(canvas: ArtCanvas): () => void {
  if (canvas.stopArt) return canvas.stopArt

  /** One art pixel, in CSS pixels. */
  const CELL = 5
  /** The stars redraw at this rate. A low rate suits the pixel look and costs little. */
  const FRAME_MS = 1000 / 24
  /** The website's blues, dark to light (`styles/marketing`). Level 0 is empty, so the page color shows. */
  const PALETTE = [
    [0, 0, 0],
    [14, 23, 48],
    [27, 47, 107],
    [36, 83, 201],
    [61, 123, 255],
    [156, 194, 255],
    [230, 239, 255],
  ]
  const TOP_LEVEL = PALETTE.length - 1
  /** The 4×4 ordered-dither thresholds, as on the dithered art of the landing page. */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)
  /**
   * The dish of the MCP page (`public/marketing/mcp-dish.webp`) as a 120 × 121 light
   * map, one hex digit (0 to f) per cell, row by row. A run of 2 to 21 zeros is one
   * letter from "g" to "z".
   */
  const DISH_W = 120
  const DISH_H = 121
  const DISH = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzn2663zzzzzo27ed72zzzzzn4bffb2zzzzzn4cffb81zzzzzm8ffea83zzzzzl4dffa662zzzzzk2cefa8553zzzzzj1cdec66664zzzzzjadef667533zzzzzi9cdfa666353zzzzzh6cdee4547442zzzzzg3ccdf84654663zzzzz02ccdec46544643zzzzz0accee536666553zzzzz9cddf8544556653zzzzy6bcded4656564663zzzzx3bcdef73546764652zzzzw2accefa54435965562zzzzwabddfe465625765352zzzzv8ccdef7366657666562zzzzu4cccefc5345556664662zzzzt2bccdee56465556653571zzzzs19bcdee857465866743671zzzzs9bbcefc456546966764561zzzzr6bdccdf6657547876875671zzzzq2bcdddd95867257965765681zzzzqabcdeeb4666646896756459zzzzq9bbcdee64566655896866668zzq33zw6bcdddfa64476747786777558zzp174687652zp3bcdeeee686566768778678577zzl38237h14ab9aa9763zjbccdeff7676678677789668489zzl372b4h34633g3778bca8652121t8ccdeffa5776688676688667379zzm3ba201643g25h1g16479deda7743311l6ccdeefd65686688797688667478zzk109bb9658b21g323k1g16359efeda76632315ccdeeff778765788997788678478zzk18ca8783631224466l1h3g27247efeecb8ccdeeffa688747779887998669488zzj16c97542348d1i2334951g1h2h4g15014dfffffffd5677789778986798558489zzi16d98575413efa61m234953124h3h5gadddefff84679887788a97978667289zzg653cb9753570cfdadb71p135964246h43cceeeffb75588786888b87868667678zz06a5bba8632308ffea8bcc94t2485547dcdefffd686667889888a78879769588zz0bccb78662604fff238c679dc61v1bdeeefff777666998a889999879659688zz0bcdb8996824effdi7da99de93t4cddeeffa78797798997899a9779558397zzg8b8bbcc62cfff5k5c978deb51p2abdeeffd5777867899a9889a8778767696zzg3309ced97fff9n3bdc6cfd71n9bbdffff777777778a99a899a7777657795zz015g5cea8dff7q29b97dec83k6bbcceffa698748977a9aa89998766857685zz014h9c5aed2u6cd6adfb4h4bbbccefc67877788888aaa89a9a778947686zzg3h6b7d795w39dacbed84bbbcdded677798878989baa99989676759876zzh4g40886ac3x18e89cffdcccdde8467888869888aaa9999a776a67685zzh205g36c6092z6ddddffeddeb75588898998899ba98889866988695zzi75h24644a1z07efeffffe78866799899899abba9879a67a7a695zzi22h205719bz0abceffff98888699899999899aa9989867a77693zzj3i608c96as8c4h8bbccdefa787987789a99a8998aaa778959956791zzj12h311b8248qaefdb45cbbccbdc588798988aa99a8999ba989897996788zzl41h301683a7pdffeafedbcccce8678889988aaaa9a999aa8886a6987885zzm8i202948e7o4dcffffffdcde979976999998aaaaa9899a587488978984zzm3i4g4da195n17dffffffffec6888769999989a9aa99a99a9787987999zzo4h44g7a53d2m8cffffffffff7888888889a999aaaa9aa89b6777a879a5zzo3i3h5c38d1k1dffffffffffa777989989aaaa8aba99a989a9666a98b93zzp91h4hb88dd1laffffffffd767998999a99aa99aaaaa8989a877999a81zzp22h22g1ce44cl4effffffe889678998aa8aa9999bbaaaa99b6689bba25zzq5h19h2ca6bbkacffffff9889979989aaaa8aaa9abaaaaabb989bba9325zzq3h13h4c66d8i8bcdffffc898999998aaaa99aaa99aaab99bca7adba83143zzp44h4i8c9cd7g5cccceffe899998a99a9aaaaaa99aaaccb8aaab9bbb8752452zzp7i4iaf92c72ccccdddf869999999aaaa999aa9aabaacb99cbadc9a58654371zzo41h91iac98eccddceee9889789999aaaba9aaaaabbcbccdcdbcdca954750246zzp6h26jbc3dfddeedfc78895799aaaaaaaaaa9aaadddeedcebedac7235603326zzo351g22i2ebeffeefed788888997aaaaaaabb99abbcccceefeffec985448443034zzoa42g4j5ffdefeff788899998aa9aaaaaaabaccdbbdeddefffec84655c415g43zzn16g145i8dffffff957799999aa99a9aabaaabcddcdeeffeffffed43cc753733233zzn5h28h4ddefeffd867788a99aaaaa9aaaa9aabffdefffffffffffb8668888887671zzn601g4gbddeffef99898888899aaaaaaaaaacbbbdffffffffffffe965888676764872zzm581g418ccdddffa9aabaaa99999999aaa9aacefdbdffffeffffffb766469863404674zzn70222bccdeeffc9aabbababbaa9999999999bcdfebcefefeffffd8798787775226355zzn34g4edcdffff99aabababbaabbbaaa9aaaaaaafffdbeefffffd666cddcb88a9871251zzn802bceeffffeecdbbaaaaaaaaaabba99aaab99deffdbeffffd947aeba99889a77g54zzn1bacdeffffffffedcbbbbbaaaaaaabbbaabbabaceefddefffdaa99884622377153036zzo8dddeffffffffedbcbbbbbbaabbaaaabbbbbbbabccffffefddd9a9868603572401362zznaddeefffffffeecbcbbbba9aaaaaaaaaaaccbaacbdfffececcadda878644463036774zzm5cdcdfffffffffcbbbaaaaaaaa9abaaaba9bbbccdbcfffeccca9ce9689621167435666zzl2cceffffffffffdcbbabbababbaaababbabbbbbbdcddefeddedabdd6688316238565678zzlaccceffffffffeddcbbbabaaabaaaaacbabbbbbcccfffffeeeeacaa68a9807a668839a9zzk7ddedfffeffedeccdcbccbbbbabba9abbdbbbcbbdbcfeffeeededc9a89bba32aa7764aaazzj2cdeefffcddccccbbbbbbbbbbcbcbbbbbbecbbbbbaadfcffdefee8cacb98ba706b9967aaazzjaceefffaabbbccbcbbbbbbabbbabbaaaaacddcbccbbbfbefceddebccdb837ba129b9a69aazzi6cdeeffc89abbcbbbbbbbbbbbbbba9a88aabbdabcbcd8cddceeddeededb925ba509aa99898zzh3cdefffe899aabbbbbaabbabbaabb9879ababbbbabbed8afddfedeefdecaa96aaa0aaa95a97zzhadeefff9999aaababbbbbbbbcbbbbaa999baaaacbaadfabfbdeedeefdda899aaba43edcadc6zzg6cdefffa7999abaabbbbbbbbbbbbaabaabaabbbbbcacdfd4bcceedffedca8aa8bca80bfeded5zz02cdefffd7789aabbbbabbbbcbbcbbbbbbbbbbbbcaabbeedd18ecefdefddc98ab8ccba16bfedc3zz09cdeffe8999aabbbccbbbbccccbbbbabbbaaaaaaabaadeff76fbefbeeddc98abacdca54effb91641zw6ccdfff9999aaababbbcbabbcbbaabbaabbbaaa8aab92cffee6fccfaeecdc88adddfdb92effd82a93zv3ccdfff98aa99aaabbabbbbbbbaaabbabbbbbbbbba83gffffdffffffffccc79ccbbeebb5bfff73793zvbdefffc879a9a99bbabaacccbbbbbbbbccbaaa9aaa9adfffffffffefefdccd7abcbcffca77ffffeab5zu6cdeffe89ab7899aaabbccccbbcbbbcbcbbaaababceffffffffeeffefeccccc7acdc8dfebb9ffece8862zk111111102deffff9aa9a88abcbbbccdccccbbbabaabcabbbaadfffffffffcbcbdfcbbccc6acfeacffcb77febeaa85zj123333322beffff979aa89bbbbbcccdcccbbabbbbbbbaabbaacccccdeffffbd9ddecbaccc6adfcceeecaa2dc9cbc84zi1234444437fffffc999b98bbccbcccccbbccbaa9cccbabbba7bdb8b6bcddefefeecdccaccd6bdfcefdecbc36baaaa84zh1234566655effffeababaabbdcbbccdccbbbbcbba78bbbbb92g268bc9decfea9ccdddcabcc5bcbccccccab74fdccddc3zg234678987cfffffabbbaaccbbaccbcbcdddcba79ababbba5m26cccde802479cbaba94bb9a6667aaab0beecb63zg13357acddcfffffbaabaaabbbbcdccccccbbbaabccb7851p2cdaccca774cb9987a5c9684378869a446574zj3468cffffffffdbaa9abbabccdccddbbaabccbcca641r3cd9abbcdbdc9898384c9543468648a844462zj2478dfffffffdbbbb9cccbcdddcbbabcbcbbcca4v4ce5dd828cdca996375da334776434abb735zj1347adffffffecbbbbccccddcaaccccbbbaba52w17ce8bb97888999a8676d95358889babceed94zj346acffffffcccbbcdcdccccabdcccbcb74z28cc89a9888899898676e955789aaccbbefeb8223z012367adffffccccccccdccddccbbccc94zh4acb589a899aa7676596eb9788877ab9acffea48bzg12457ffffdddbbbcddccdcccdca752zj39cc58bccccba8876689edc8653228989bdfec4444z012349fffdcddbbddccccbbcbc8741zk29dd69bdcccba9887789edb8652335899bceed74461z0123efeecddcdddcbbbdcd961zo3aeea9acbbb9a799878aedc78878989bcdcbbca9481zg28eedcdddbbcddcb8741zq14aabbaa989aaaabbbbccfffedcccdcccefffdcbbb931z04aedcccddcbbba86431zq134889a9989aaaabbbbcccffffeeddddcdeeffeeddcb63z18beccccacddb963zt1256567b88abbb99bbbbcccfffffeddddddeefffffffd96z1accbccca96421zu26a87778baaabbbaaabbbcccfffffeddddddeffffffffdb8z069aaa986431zw48b98989bbbbbbbbabbbbcccfffffedddddddffffffffedb41122101121q489763zz058b99baabbbbbbbbbbbbbcccfffffeeeeddddffffffffefea44543024431zzw69a99ccccccccbbbbbbbbdddfffffeeeeddddfffffffffffe99c95168b84zzw68589cccccccca6bbbbaadddec9ffedddddddffffffbbfffd57dc9537ba61zzv54059cccccccc609bbba9ddde50ffedddddddffffff33ffeb03efdb04bc82h"

  // A seeded random source, so a restart on the same canvas (React's strict mode
  // runs effects twice) draws the same scene.
  if (canvas.artSeed === undefined) canvas.artSeed = Math.floor(Math.random() * 2 ** 32)
  let state = canvas.artSeed
  const random = () => {
    state = (state + 0x6d2b79f5) | 0
    let r = Math.imul(state ^ (state >>> 15), 1 | state)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }

  const smooth = (from: number, to: number, v: number) => {
    const k = Math.min(1, Math.max(0, (v - from) / (to - from)))
    return k * k * (3 - 2 * k)
  }

  const dish = new Float32Array(DISH_W * DISH_H)
  for (let i = 0, o = 0; i < DISH.length; i++) {
    const c = DISH.charCodeAt(i)
    if (c >= 103) o += c - 101
    else dish[o++] = parseInt(DISH[i], 16) / 15
  }

  /** The dish light at a point of the map, between cells. */
  const sampleDish = (u: number, v: number) => {
    const x0 = Math.min(DISH_W - 2, Math.max(0, Math.floor(u)))
    const y0 = Math.min(DISH_H - 2, Math.max(0, Math.floor(v)))
    const fx = Math.min(1, Math.max(0, u - x0))
    const fy = Math.min(1, Math.max(0, v - y0))
    const i = y0 * DISH_W + x0
    const top = dish[i] * (1 - fx) + dish[i + 1] * fx
    const bottom = dish[i + DISH_W] * (1 - fx) + dish[i + DISH_W + 1] * fx
    return top * (1 - fy) + bottom * fy
  }

  /** Light values to palette levels, with the ordered dither between two levels. */
  const put = (data: Uint8ClampedArray, i: number, x: number, y: number, v: number) => {
    const s = Math.max(0, v) * TOP_LEVEL
    let level = Math.floor(s)
    if (s - level > BAYER[(y & 3) * 4 + (x & 3)]) level++
    if (level > TOP_LEVEL) level = TOP_LEVEL
    const o = i * 4
    if (level === 0) {
      data[o + 3] = 0
      return
    }
    data[o] = PALETTE[level][0]
    data[o + 1] = PALETTE[level][1]
    data[o + 2] = PALETTE[level][2]
    data[o + 3] = 255
  }

  const buildScene = (width: number, height: number): Scene => {
    const cols = Math.ceil(width / CELL)
    const rows = Math.ceil(height / CELL)
    // The dish stands on the ground at the bottom of the panel, right of the logo's wordmark,
    // with a margin from the page edge. The ground is the lit horizon line and one row under it.
    const groundTop = rows - 2
    const left = Math.round(Math.max(120, width * 0.3) / CELL)
    const right = cols - Math.round(Math.max(16, width * 0.04) / CELL)
    const dishW = right - left
    const dishH = Math.round((dishW * DISH_H) / DISH_W)
    // The bottom row of the map is the foot of the base, so it rests on the ground line.
    const dishTop = groundTop - dishH

    // The dish lights the ground under its base.
    const poolX = left + dishW * 0.72
    const poolR = dishW * 0.45

    // One palette step. The sky starts on it, so its top is a clean navy with no dither.
    const STEP = 1 / TOP_LEVEL
    const still = new Uint8ClampedArray(cols * rows * 4)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x
        let v: number

        if (y < groundTop) {
          // The night sky over the whole panel: one clean navy, lighter in a thin band above the horizon.
          v = STEP + 0.0005 + 0.12 * smooth(0.86, 1, y / groundTop)

          if (x >= left && x < right && y >= dishTop) {
            const light = sampleDish(((x - left) / dishW) * DISH_W, ((y - dishTop) / dishH) * DISH_H)
            if (light > 0.04) v = Math.max(v, Math.min(1, light * 1.25))
          }
        } else {
          // The ground: the lit horizon line, brightest under the dish where its light falls.
          const p = (x - poolX) / poolR
          const pool = Math.abs(p) < 1 ? 0.3 * (1 - p * p) : 0
          v = (y === groundTop ? 2 * STEP + 0.001 : STEP + 0.0005) + pool
        }

        put(still, i, x, y, v)
      }
    }

    // Stars fill the sky above the ground, away from the dish and the logo.
    const stars: Star[] = []
    const logoRow = rows / 2
    for (let n = Math.round((cols * rows) / 300); n > 0; n--) {
      const x = Math.floor(random() * cols)
      const y = Math.floor(random() * (groundTop - 4))
      const onDish =
        x >= left - 2 &&
        x < right + 2 &&
        y >= dishTop - 2 &&
        sampleDish(((x - left) / dishW) * DISH_W, ((y - dishTop) / dishH) * DISH_H) > 0.02
      const onLogo = x < 34 && Math.abs(y - logoRow) < 10
      if (!onDish && !onLogo) stars.push({ x, y, phase: random() * 6.28, speed: 0.5 + random() * 1.4 })
    }

    return { cols, rows, still, stars }
  }

  const draw = (scene: Scene, image: ImageData, t: number) => {
    image.data.set(scene.still)
    // Each star fades in and out through the palette, and rests unlit part of the time.
    for (const star of scene.stars) {
      const lit = Math.sin((t / 1000) * star.speed + star.phase)
      if (lit > -0.2) put(image.data, star.y * scene.cols + star.x, star.x, star.y, 0.45 + 0.55 * ((lit + 0.2) / 1.2))
    }
  }

  const ctx = canvas.getContext("2d")
  const box = canvas.parentElement
  if (!ctx || !box) return () => {}

  let scene: Scene | null = null
  let image: ImageData | null = null
  const start = performance.now()
  let last = 0
  let frame = 0

  const paint = (now: number) => {
    if (!scene || !image) return
    last = now
    draw(scene, image, now - start)
    ctx.putImageData(image, 0, 0)
  }

  const resize = () => {
    const { width, height } = box.getBoundingClientRect()
    if (width === 0 || height === 0) return
    // The first observer callback reports the size the art already has.
    if (scene && scene.cols === Math.ceil(width / CELL) && scene.rows === Math.ceil(height / CELL)) return
    scene = buildScene(width, height)
    canvas.width = scene.cols
    canvas.height = scene.rows
    canvas.style.width = `${scene.cols * CELL}px`
    canvas.style.height = `${scene.rows * CELL}px`
    image = ctx.createImageData(scene.cols, scene.rows)
    // Draw now, so no frame shows the canvas empty.
    paint(performance.now())
  }

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick)
    if (now - last >= FRAME_MS) paint(now)
  }

  const observer = new ResizeObserver(resize)
  observer.observe(box)
  resize()
  frame = requestAnimationFrame(tick)

  const stop = () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
    canvas.stopArt = undefined
  }
  canvas.stopArt = stop
  return stop
}

/** Starts the art on the canvas in the element just before the script, while the HTML loads. */
const START_SCRIPT = `(${startDishArt.toString()})(document.currentScript.previousElementSibling.firstElementChild)`

/**
 * The login panel's dish art: the deep-space antenna of the MCP page, redrawn in the
 * website's dithered pixel look. The dish stands on a ground of broken pixels under
 * a night sky. Only the stars move: they fade in and out. Drawn on a canvas one cell
 * per canvas pixel, then scaled up with `image-rendering: pixelated`.
 *
 * On a full page load, the inline script starts the art while the HTML loads, so it
 * shows with the first paint, before React hydrates. On a visit from another page of
 * the app the script does not run, and the layout effect starts the art before the
 * first paint instead.
 */
export function PixelDishArt({ className }: { className?: string }) {
  const canvasRef = useRef<ArtCanvas>(null)

  // After a full page load the art already runs, and this call takes it over.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    return canvas ? startDishArt(canvas) : undefined
  }, [])

  return (
    <>
      <div className={className}>
        {/* The script sets the canvas size before React hydrates. */}
        <canvas ref={canvasRef} className="block [image-rendering:pixelated]" suppressHydrationWarning />
      </div>
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: START_SCRIPT }} />
    </>
  )
}
