import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';

export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  const token = localStorage.getItem('vizyo-tracky-token');
  if (token) return true;
  return router.createUrlTree(['/login']);
};
