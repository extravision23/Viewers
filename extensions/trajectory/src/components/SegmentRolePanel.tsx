import React from 'react';
import {
  OBSTACLE_SUBTYPES,
  type MeshRole,
  type ObstacleSubtype,
} from '@extravision/trajectory-planner';
import type { RoleManager } from '../planner/RoleManager';

const ROLES: MeshRole[] = ['TARGET', 'ENTRY_SURFACE', 'OBSTACLE', 'CONTEXT', 'IGNORE'];

type SegmentRolePanelProps = {
  roleManager: RoleManager;
  onRolesChanged: () => void;
};

export default function SegmentRolePanel({ roleManager, onRolesChanged }: SegmentRolePanelProps) {
  const meshes = roleManager.getAllMeshes();

  const handleRoleChange = (meshId: string, role: MeshRole) => {
    roleManager.setRole(meshId, role);
    onRolesChanged();
  };

  const handleSubtypeChange = (meshId: string, subtype: ObstacleSubtype) => {
    roleManager.setObstacleSubtype(meshId, subtype);
    onRolesChanged();
  };

  if (!meshes.length) {
    return <p className="text-muted-foreground text-xs">No segment meshes loaded.</p>;
  }

  return (
    <div className="max-h-48 overflow-y-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b">
            <th className="py-1 text-left font-medium">Segment</th>
            <th className="py-1 text-left font-medium">Role</th>
            <th className="py-1 text-left font-medium">Subtype</th>
          </tr>
        </thead>
        <tbody>
          {meshes.map(meta => (
            <tr
              key={meta.id}
              className="border-b border-white/5"
            >
              <td className="py-1 pr-2">{meta.name}</td>
              <td className="py-1 pr-2">
                <select
                  className="bg-background border-input w-full rounded border px-1 py-0.5"
                  value={meta.role}
                  onChange={e => handleRoleChange(meta.id, e.target.value as MeshRole)}
                >
                  {ROLES.map(r => (
                    <option
                      key={r}
                      value={r}
                    >
                      {r}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-1">
                {meta.role === 'OBSTACLE' ? (
                  <select
                    className="bg-background border-input w-full rounded border px-1 py-0.5"
                    value={roleManager.getObstacleSubtype(meta.id) ?? 'other'}
                    onChange={e =>
                      handleSubtypeChange(meta.id, e.target.value as ObstacleSubtype)
                    }
                  >
                    {OBSTACLE_SUBTYPES.map(s => (
                      <option
                        key={s}
                        value={s}
                      >
                        {s}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
