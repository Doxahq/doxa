import type { Rigid } from "~/lib/marketing/solve-art/math"
import { OCCLUDERS, type Material, type PartSink, type Rgb } from "~/lib/marketing/solve-art/rig"

/** Three rows of the transform, half size + bevel, color + material, taper. */
const FLOATS_PER_PART = 21
/** A part past these limits disappears with no error. */
export const MAX_BOXES = 240
export const MAX_CYLINDERS = 80
const CYLINDER_SIDES = 14

const VERTEX = `#version 300 es
layout(location=0) in vec3 aCorner;
layout(location=1) in vec3 aOffset;
layout(location=2) in vec3 aNormal;
layout(location=3) in vec4 aRow0;
layout(location=4) in vec4 aRow1;
layout(location=5) in vec4 aRow2;
layout(location=6) in vec4 aHalf;
layout(location=7) in vec4 aColor;
layout(location=8) in float aTaper;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vPos;
out vec4 vColor;
void main() {
  // The bevel keeps one width, whatever the proportions of the part.
  vec3 p = aCorner * (aHalf.xyz - aHalf.w) + aOffset * aHalf.w;
  p.xy *= 1.0 - aTaper * (0.5 + 0.5 * p.z / aHalf.z);
  vec4 q = vec4(p, 1.0);
  vPos = vec3(dot(aRow0, q), dot(aRow1, q), dot(aRow2, q));
  vNormal = vec3(dot(aRow0.xyz, aNormal), dot(aRow1.xyz, aNormal), dot(aRow2.xyz, aNormal));
  vColor = aColor;
  gl_Position = uViewProj * vec4(vPos, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vPos;
in vec4 vColor;
uniform vec3 uEye;
uniform vec4 uOccluders[${OCCLUDERS}];
uniform float uGlow;
uniform vec2 uFade;
uniform vec3 uArmWrists[2];
uniform vec2 uArmFade;
out vec4 outColor;
const vec3 KEY_DIR = vec3(-0.40, 0.78, 0.48);
const vec3 RIM_DIR = vec3(0.72, 0.28, -0.64);
const vec3 FILL_DIR = vec3(-0.5, -0.78, 0.36);
const vec3 ICE = vec3(0.61, 0.76, 1.0);
const vec3 BLUE = vec3(0.24, 0.48, 1.0);
float grain(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vPos);
  float m = vColor.a;
  // A fading shell is a shell that sinks into the page, away from its wrist.
  bool fading = m > 3.5;
  if (fading) m -= 4.0;
  vec3 base = vColor.rgb;
  vec3 c;
  if (m > 1.5 && m < 2.5) {
    c = base * 1.15;
  } else {
    float key = max(dot(n, KEY_DIR), 0.0);
    float rim = max(dot(n, RIM_DIR), 0.0);
    float fill = max(dot(n, FILL_DIR), 0.0);
    float facing = max(dot(n, v), 0.0);
    float fres = pow(1.0 - facing, 3.0);
    float spec = pow(max(dot(n, normalize(KEY_DIR + v)), 0.0), 42.0);
    if (m < 0.5) {
      // Machined shell: broad light on flat plates, thin rim light on the edges.
      c = base * (0.34 + 1.25 * key + 0.5 * fill * BLUE + 0.85 * rim * ICE);
      c += spec * 0.5 + fres * ICE * 0.2;
    } else {
      // The cube sits close together, so it darkens near the fingers and palms.
      float ao = 1.0;
      for (int i = 0; i < ${OCCLUDERS}; i++) {
        float d = length(vPos - uOccluders[i].xyz) / uOccluders[i].w;
        ao *= 0.3 + 0.7 * smoothstep(0.0, 1.0, d);
      }
      if (m < 1.5) {
        c = base * ((0.5 + 0.72 * key + 0.16 * fill + 0.28 * rim) * ao + uGlow * 0.32);
        c += spec * 0.5 * ao;
      } else {
        c = base * (0.5 + 1.2 * key) * ao + spec * 0.22 * ao + fres * ICE * 0.03;
      }
    }
  }
  // The arms can sink into the page color, away from the center of the scene.
  float a = uFade.y > 0.0 ? 1.0 - smoothstep(uFade.x, uFade.y, length(vPos)) : 1.0;
  if (fading) a *= 1.0 - smoothstep(uArmFade.x, uArmFade.y, min(length(vPos - uArmWrists[0]), length(vPos - uArmWrists[1])));
  c += (grain(gl_FragCoord.xy) - 0.5) * 0.028;
  outColor = vec4(max(c, 0.0) * a, a);
}`

export interface MeshData {
  corner: number[]
  offset: number[]
  normal: number[]
  index: number[]
}

/** Adds a triangle facing outward, whichever order the vertices come in. */
function triangle(mesh: MeshData, i: number, j: number, k: number): void {
  const at = (v: number, n: number) => mesh.corner[v * 3 + n] + mesh.offset[v * 3 + n] * 0.2
  const e1 = [at(j, 0) - at(i, 0), at(j, 1) - at(i, 1), at(j, 2) - at(i, 2)]
  const e2 = [at(k, 0) - at(i, 0), at(k, 1) - at(i, 1), at(k, 2) - at(i, 2)]
  const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  const avg = [0, 1, 2].map((n) => mesh.normal[i * 3 + n] + mesh.normal[j * 3 + n] + mesh.normal[k * 3 + n])
  const outward = cross[0] * avg[0] + cross[1] * avg[1] + cross[2] * avg[2] >= 0
  if (outward) mesh.index.push(i, j, k)
  else mesh.index.push(i, k, j)
}

/**
 * A box with one soft edge: each corner has three vertices, one per face. Flat
 * faces stay flat, and the normals blend across the bevel, so the edges catch the
 * light as if they were round. 24 vertices and 44 triangles.
 */
export function boxMesh(): MeshData {
  const mesh: MeshData = { corner: [], offset: [], normal: [], index: [] }
  const signs: number[][] = []
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) signs.push([x, y, z])
  for (const s of signs) {
    for (let axis = 0; axis < 3; axis++) {
      const n = [0, 0, 0]
      n[axis] = s[axis]
      mesh.corner.push(...s)
      mesh.offset.push(...n)
      mesh.normal.push(...n)
    }
  }
  const v = (corner: number, axis: number) => corner * 3 + axis
  // Corners index by bits: x = 4, y = 2, z = 1.
  const bit = (axis: number) => 4 >> axis
  for (let c = 0; c < 8; c++) {
    triangle(mesh, v(c, 0), v(c, 1), v(c, 2))
    for (let along = 0; along < 3; along++) {
      if (c & bit(along)) continue
      const d = c | bit(along)
      const p = (along + 1) % 3
      const q = (along + 2) % 3
      triangle(mesh, v(c, p), v(c, q), v(d, q))
      triangle(mesh, v(c, p), v(d, q), v(d, p))
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    const p = (axis + 1) % 3
    const q = (axis + 2) % 3
    for (const side of [0, bit(axis)]) {
      const c0 = side
      const c1 = side | bit(p)
      const c2 = side | bit(p) | bit(q)
      const c3 = side | bit(q)
      triangle(mesh, v(c0, axis), v(c1, axis), v(c2, axis))
      triangle(mesh, v(c0, axis), v(c2, axis), v(c3, axis))
    }
  }
  return mesh
}

/** A cylinder on the y axis with the same soft edge as `boxMesh`. */
export function cylinderMesh(sides = CYLINDER_SIDES): MeshData {
  const mesh: MeshData = { corner: [], offset: [], normal: [], index: [] }
  const add = (corner: number[], offset: number[], normal: number[]) => {
    mesh.corner.push(...corner)
    mesh.offset.push(...offset)
    mesh.normal.push(...normal)
    return mesh.corner.length / 3 - 1
  }
  for (const y of [-1, 1]) {
    const center = add([0, y, 0], [0, y, 0], [0, y, 0])
    const capRing: number[] = []
    const sideRing: number[] = []
    for (let i = 0; i < sides; i++) {
      const t = (i / sides) * Math.PI * 2
      const cx = Math.cos(t)
      const cz = Math.sin(t)
      capRing.push(add([cx, y, cz], [0, y, 0], [0, y, 0]))
      sideRing.push(add([cx, y, cz], [cx, 0, cz], [cx, 0, cz]))
    }
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides
      triangle(mesh, center, capRing[i], capRing[next])
      triangle(mesh, capRing[i], sideRing[i], sideRing[next])
      triangle(mesh, capRing[i], sideRing[next], capRing[next])
    }
  }
  // The wall between the two side rings. Each end adds 1 + 2 · sides vertices.
  const ringStart = (end: number) => end * (1 + 2 * sides) + 1
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides
    const a0 = ringStart(0) + i * 2 + 1
    const a1 = ringStart(0) + next * 2 + 1
    const b0 = ringStart(1) + i * 2 + 1
    const b1 = ringStart(1) + next * 2 + 1
    triangle(mesh, a0, a1, b1)
    triangle(mesh, a0, b1, b0)
  }
  return mesh
}

class PartList {
  readonly data: Float32Array
  count = 0

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity * FLOATS_PER_PART)
  }

  add(m: Rigid, hx: number, hy: number, hz: number, bevel: number, color: Rgb, material: number, taper: number): void {
    if (this.count >= this.capacity) return
    const d = this.data
    const o = this.count * FLOATS_PER_PART
    for (let i = 0; i < 12; i++) d[o + i] = m[i]
    d[o + 12] = hx
    d[o + 13] = hy
    d[o + 14] = hz
    d[o + 15] = bevel
    d[o + 16] = color[0]
    d[o + 17] = color[1]
    d[o + 18] = color[2]
    d[o + 19] = material
    d[o + 20] = taper
    this.count += 1
  }
}

interface Batch {
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  list: PartList
  indexCount: number
}

function compile(gl: WebGL2RenderingContext): WebGLProgram | null {
  const program = gl.createProgram()
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null
}

function createBatch(gl: WebGL2RenderingContext, mesh: MeshData, capacity: number): Batch {
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)

  const vertices: number[] = []
  for (let i = 0; i < mesh.corner.length / 3; i++) {
    vertices.push(...mesh.corner.slice(i * 3, i * 3 + 3), ...mesh.offset.slice(i * 3, i * 3 + 3), ...mesh.normal.slice(i * 3, i * 3 + 3))
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW)
  for (let i = 0; i < 3; i++) {
    gl.enableVertexAttribArray(i)
    gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 36, i * 12)
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.index), gl.STATIC_DRAW)

  const list = new PartList(capacity)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, list.data.byteLength, gl.DYNAMIC_DRAW)
  const stride = FLOATS_PER_PART * 4
  for (let i = 0; i < 5; i++) {
    gl.enableVertexAttribArray(3 + i)
    gl.vertexAttribPointer(3 + i, 4, gl.FLOAT, false, stride, i * 16)
    gl.vertexAttribDivisor(3 + i, 1)
  }
  gl.enableVertexAttribArray(8)
  gl.vertexAttribPointer(8, 1, gl.FLOAT, false, stride, 80)
  gl.vertexAttribDivisor(8, 1)
  gl.bindVertexArray(null)
  return { vao, buffer, list, indexCount: mesh.index.length }
}

export interface Renderer {
  readonly gl: WebGL2RenderingContext
  sink: PartSink
  occluders: Float32Array
  /** Fading shells start to sink into the page at `near` from a wrist, and they are gone at `far`. */
  setArmFade(wrists: Float32Array, near: number, far: number): void
  /** Clears the part lists for a new frame. */
  begin(): void
  /** Draws the parts in the lists. */
  flush(viewProj: Float32Array, eye: readonly number[], glow: number): void
}

/**
 * Returns null when the browser has no WebGL2. The section then shows its copy on the
 * plain page. `fade` is the distance from the center of the scene at which parts start
 * to sink into the page and the distance at which they are gone. With null, they stay.
 */
export function createRenderer(canvas: HTMLCanvasElement, fade: readonly [number, number] | null = [6.2, 12.5]): Renderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    powerPreference: "low-power",
    stencil: false,
  })
  if (!gl) return null
  const program = compile(gl)
  if (!program) return null

  const boxes = createBatch(gl, boxMesh(), MAX_BOXES)
  const cylinders = createBatch(gl, cylinderMesh(), MAX_CYLINDERS)
  const uViewProj = gl.getUniformLocation(program, "uViewProj")
  const uEye = gl.getUniformLocation(program, "uEye")
  const uGlow = gl.getUniformLocation(program, "uGlow")
  const uOccluders = gl.getUniformLocation(program, "uOccluders")
  const uArmWrists = gl.getUniformLocation(program, "uArmWrists")
  const uArmFade = gl.getUniformLocation(program, "uArmFade")
  const occluders = new Float32Array(OCCLUDERS * 4)

  gl.useProgram(program)
  gl.uniform2f(gl.getUniformLocation(program, "uFade"), fade ? fade[0] : 0, fade ? fade[1] : 0)
  gl.enable(gl.DEPTH_TEST)
  gl.enable(gl.CULL_FACE)
  gl.clearColor(0, 0, 0, 0)

  const sink: PartSink = {
    box(m, hx, hy, hz, bevel, color, material: Material, taper = 0) {
      boxes.list.add(m, hx, hy, hz, bevel, color, material, taper)
    },
    cylinder(m, radius, halfHeight, bevel, color, material: Material) {
      cylinders.list.add(m, radius, halfHeight, radius, bevel, color, material, 0)
    },
  }

  return {
    gl,
    sink,
    occluders,
    setArmFade(wrists, near, far) {
      gl.uniform3fv(uArmWrists, wrists)
      gl.uniform2f(uArmFade, near, far)
    },
    begin() {
      boxes.list.count = 0
      cylinders.list.count = 0
    },
    flush(viewProj, eye, glow) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.uniformMatrix4fv(uViewProj, false, viewProj)
      gl.uniform3f(uEye, eye[0], eye[1], eye[2])
      gl.uniform1f(uGlow, glow)
      gl.uniform4fv(uOccluders, occluders)
      for (const batch of [boxes, cylinders]) {
        gl.bindVertexArray(batch.vao)
        gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.list.data, 0, batch.list.count * FLOATS_PER_PART)
        gl.drawElementsInstanced(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_SHORT, 0, batch.list.count)
      }
      gl.bindVertexArray(null)
    },
  }
}
