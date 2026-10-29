const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({ log: ["error"] });
(async () => {
  const user = await p.user.findUnique({ where: { email: "member@fernly.app" } });
  const owned = await p.project.findMany({ where: { ownerName: user.name }, select: { id: true } });
  const assignedProjects = await p.task.findMany({
    where: { assignee: { name: user.name } }, select: { projectId: true }, distinct: ["projectId"],
  });
  const explicit = await p.projectAssignment.findMany({ where: { userId: user.id }, select: { projectId: true } });
  const ids = new Set([
    ...owned.map(o => o.id),
    ...assignedProjects.map(t => t.projectId).filter(Boolean),
    ...explicit.map(a => a.projectId),
  ]);
  const scopedTasks = await p.task.count({
    where: { OR: [{ projectId: { in: [...ids] } }, { assignee: { name: user.name } }] },
  });
  const totalTasks = await p.task.count();
  const scopedProjects = await p.project.count({ where: { id: { in: [...ids] } } });
  console.log(`member=${user.name} | scoped projects=${scopedProjects}/${await p.project.count()} | scoped tasks=${scopedTasks}/${totalTasks}`);
  await p.$disconnect();
})();
