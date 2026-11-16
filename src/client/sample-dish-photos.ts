import chai from './art/masala-chai.webp';
import paneer from './art/paneer-tikka.webp';
import biryani from './art/veg-biryani.webp';
import jamun from './art/gulab-jamun.webp';

const photos = new Map([['masala chai', chai], ['paneer tikka', paneer], ['veg biryani', biryani], ['gulab jamun', jamun]]);

export function sampleDishPhoto(name: string) {
  return photos.get(name.toLowerCase());
}
