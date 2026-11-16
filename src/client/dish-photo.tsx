import { Utensils } from 'lucide-react';
import { menuPhotoPath, type MenuItem } from '../shared/contracts.js';
import { sampleDishPhoto } from './sample-dish-photos.js';

export function DishPhoto({ item, sample }: { item?: Pick<MenuItem, 'id' | 'photoKey' | 'name'>; sample?: boolean }) {
  const src = item?.photoKey ? menuPhotoPath(item.id, item.photoKey) : sample && item ? sampleDishPhoto(item.name) : undefined;
  return src ? <img className="staff-dish-photo" src={src} alt="" loading="lazy" />
    : <span className="staff-dish-photo staff-dish-placeholder" aria-hidden="true"><Utensils /></span>;
}
