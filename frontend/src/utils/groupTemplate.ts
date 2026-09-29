import { genId, isArrowShape, type Shape, type ShapeGroup } from '@/canvas/types'

export interface GroupTemplate {
  rootGroupIds: string[]
  groups: ShapeGroup[]
  shapes: Shape[]
}

export function cloneGroupTemplate(source: GroupTemplate, centerX: number, centerY: number): GroupTemplate {
  const idMap = new Map<string, string>()
  for (const group of source.groups) idMap.set(group.id, genId('g'))
  for (const shape of source.shapes) idMap.set(shape.id, genId())

  const minX = source.shapes.length > 0 ? Math.min(...source.shapes.map((shape) => shape.x)) : 0
  const minY = source.shapes.length > 0 ? Math.min(...source.shapes.map((shape) => shape.y)) : 0
  const maxX = source.shapes.length > 0 ? Math.max(...source.shapes.map((shape) => shape.x + shape.w)) : 0
  const maxY = source.shapes.length > 0 ? Math.max(...source.shapes.map((shape) => shape.y + shape.h)) : 0
  const offsetX = centerX - (minX + maxX) / 2
  const offsetY = centerY - (minY + maxY) / 2

  const groups = source.groups.map((group) => ({
    ...structuredClone(group),
    id: idMap.get(group.id)!,
    childIds: group.childIds.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id)),
    parentId: group.parentId ? idMap.get(group.parentId) : undefined,
  }))

  const shapes = source.shapes.map((sourceShape) => {
    let shape = {
      ...structuredClone(sourceShape),
      id: idMap.get(sourceShape.id)!,
      x: sourceShape.x + offsetX,
      y: sourceShape.y + offsetY,
      groupId: sourceShape.groupId ? idMap.get(sourceShape.groupId) : undefined,
    } as Shape

    if (shape.link?.kind === 'shape') {
      const targetId = shape.link.targetId ? idMap.get(shape.link.targetId) : undefined
      shape = { ...shape, link: targetId ? { ...shape.link, targetId } : undefined }
    }

    if (isArrowShape(shape)) {
      const startShapeId = shape.startBinding ? idMap.get(shape.startBinding.shapeId) : undefined
      const endShapeId = shape.endBinding ? idMap.get(shape.endBinding.shapeId) : undefined
      shape = {
        ...shape,
        startBinding: startShapeId && shape.startBinding
          ? { ...shape.startBinding, shapeId: startShapeId }
          : undefined,
        endBinding: endShapeId && shape.endBinding
          ? { ...shape.endBinding, shapeId: endShapeId }
          : undefined,
      }
    }

    return shape
  })

  return {
    rootGroupIds: source.rootGroupIds.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id)),
    groups,
    shapes,
  }
}
