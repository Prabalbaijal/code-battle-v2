import type { AdminProblem } from '@cb/contracts';
import type { Difficulty } from '@cb/contracts/constants';
import { Badge } from '@cb/ui';

const DIFFICULTY_VARIANT = { Easy: 'success', Medium: 'warning', Hard: 'destructive' } as const;
const STATUS_VARIANT = { draft: 'secondary', published: 'success', archived: 'warning' } as const;

export const DifficultyBadge = ({ difficulty }: { difficulty: Difficulty }) => (
  <Badge variant={DIFFICULTY_VARIANT[difficulty]}>{difficulty}</Badge>
);

export const StatusBadge = ({ status }: { status: AdminProblem['status'] }) => (
  <Badge variant={STATUS_VARIANT[status]} className="capitalize">
    {status}
  </Badge>
);
