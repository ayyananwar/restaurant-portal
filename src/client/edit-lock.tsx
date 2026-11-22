import { createContext, useContext, useEffect, useId } from 'react';

export const EditLockContext = createContext<{ locked: boolean; setLock: (id: string, active: boolean) => void }>({
  locked: false, setLock: () => {}
});

// Independent forms hold independent locks, so closing one cannot discard another form's protection.
export function useProtectedEdit() {
  const id = useId();
  const { setLock } = useContext(EditLockContext);
  useEffect(() => { setLock(id, true); return () => setLock(id, false); }, [id, setLock]);
}

export function useEditsLocked() { return useContext(EditLockContext).locked; }
