/**
 * Rigid transforms as 12 numbers: three rows, each with three rotation values and
 * one translation value. A part's size is a separate value in the shader, so a
 * transform never scales, and it can rotate normals too.
 */
export type Rigid = Float32Array
export type Vec3 = readonly [number, number, number]

export const rigid = (): Rigid => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0)

/** out = a · b. `out` can be `a` or `b`. */
export function multiply(out: Rigid, a: Rigid, b: Rigid): Rigid {
  for (let row = 0; row < 3; row++) {
    const i = row * 4
    const x = a[i]
    const y = a[i + 1]
    const z = a[i + 2]
    const w = a[i + 3]
    out[i] = x * b[0] + y * b[4] + z * b[8]
    out[i + 1] = x * b[1] + y * b[5] + z * b[9]
    out[i + 2] = x * b[2] + y * b[6] + z * b[10]
    out[i + 3] = x * b[3] + y * b[7] + z * b[11] + w
  }
  return out
}

/** out = m · a translation. `out` can be `m`. */
export function translate(out: Rigid, m: Rigid, x: number, y: number, z: number): Rigid {
  if (out !== m) out.set(m)
  out[3] += m[0] * x + m[1] * y + m[2] * z
  out[7] += m[4] * x + m[5] * y + m[6] * z
  out[11] += m[8] * x + m[9] * y + m[10] * z
  return out
}

/** Rx turns +z toward -y, which is the way a finger flexes. `out` can be `m`. */
export function rotateX(out: Rigid, m: Rigid, angle: number): Rigid {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  for (let row = 0; row < 3; row++) {
    const i = row * 4
    const y = m[i + 1]
    const z = m[i + 2]
    out[i] = m[i]
    out[i + 1] = y * c + z * s
    out[i + 2] = z * c - y * s
    out[i + 3] = m[i + 3]
  }
  return out
}

/** Ry turns +z toward +x. `out` can be `m`. */
export function rotateY(out: Rigid, m: Rigid, angle: number): Rigid {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  for (let row = 0; row < 3; row++) {
    const i = row * 4
    const x = m[i]
    const z = m[i + 2]
    out[i] = x * c - z * s
    out[i + 1] = m[i + 1]
    out[i + 2] = x * s + z * c
    out[i + 3] = m[i + 3]
  }
  return out
}

/** Rz turns +x toward +y. `out` can be `m`. */
export function rotateZ(out: Rigid, m: Rigid, angle: number): Rigid {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  for (let row = 0; row < 3; row++) {
    const i = row * 4
    const x = m[i]
    const y = m[i + 1]
    out[i] = x * c + y * s
    out[i + 1] = y * c - x * s
    out[i + 2] = m[i + 2]
    out[i + 3] = m[i + 3]
  }
  return out
}

/** The pixel ratio of a canvas of this size in CSS pixels, within a ratio and a pixel budget. */
export function budgetedPixelRatio(deviceRatio: number, width: number, height: number, maxRatio: number, maxPixels: number): number {
  return Math.min(deviceRatio || 1, maxRatio, Math.sqrt(maxPixels / (width * height)))
}

export function transformPoint(m: Rigid, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ]
}

/** The transform that undoes `m`. */
export function invert(m: Rigid): Rigid {
  return invertTo(rigid(), m)
}

/** out = the transform that undoes `m`. `out` cannot be `m`. */
export function invertTo(out: Rigid, m: Rigid): Rigid {
  out[0] = m[0]
  out[1] = m[4]
  out[2] = m[8]
  out[4] = m[1]
  out[5] = m[5]
  out[6] = m[9]
  out[8] = m[2]
  out[9] = m[6]
  out[10] = m[10]
  out[3] = -(m[0] * m[3] + m[4] * m[7] + m[8] * m[11])
  out[7] = -(m[1] * m[3] + m[5] * m[7] + m[9] * m[11])
  out[11] = -(m[2] * m[3] + m[6] * m[7] + m[10] * m[11])
  return out
}

/** Sets `m` to sit at `from` with its +z axis toward `to`, and its +y axis as near to world up as it can. */
export function aim(m: Rigid, from: Vec3, to: Vec3): Rigid {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  const zl = Math.hypot(dx, dy, dz)
  const zx = dx / zl
  const zy = dy / zl
  const zz = dz / zl
  // x = up × z, with up = +y.
  const xl = Math.hypot(zz, zx)
  const xx = zz / xl
  const xz = -zx / xl
  // y = z × x.
  const yx = zy * xz
  const yy = zz * xx - zx * xz
  const yz = -zy * xx
  m[0] = xx
  m[1] = yx
  m[2] = zx
  m[3] = from[0]
  m[4] = 0
  m[5] = yy
  m[6] = zy
  m[7] = from[1]
  m[8] = xz
  m[9] = yz
  m[10] = zz
  m[11] = from[2]
  return m
}

/**
 * A camera at `azimuth` and `elevation` around the origin, as a clip-space matrix
 * in column order. `shiftX` and `shiftY` move the origin on screen, in clip units,
 * with no change to the perspective. Returns the camera position.
 */
export function orbitCamera(
  out: Float32Array,
  options: { azimuth: number; elevation: number; distance: number; focal: number; aspect: number; shiftX: number; shiftY: number; far?: number },
): [number, number, number] {
  const { azimuth, elevation, distance: d, focal, aspect, shiftX, shiftY, far = 80 } = options
  const ce = Math.cos(elevation)
  // The view axes: back (toward the camera), right and up.
  const back = [Math.sin(azimuth) * ce, Math.sin(elevation), Math.cos(azimuth) * ce]
  const right = [Math.cos(azimuth), 0, -Math.sin(azimuth)]
  const up = [back[1] * right[2], back[2] * right[0] - back[0] * right[2], -back[1] * right[0]]

  const near = 1
  const a = (far + near) / (near - far)
  const b = (2 * far * near) / (near - far)
  const fx = focal / aspect
  for (let k = 0; k < 3; k++) {
    out[k * 4] = fx * right[k] - shiftX * back[k]
    out[k * 4 + 1] = focal * up[k] - shiftY * back[k]
    out[k * 4 + 2] = a * back[k]
    out[k * 4 + 3] = -back[k]
  }
  out[12] = shiftX * d
  out[13] = shiftY * d
  out[14] = b - a * d
  out[15] = d
  return [back[0] * d, back[1] * d, back[2] * d]
}
