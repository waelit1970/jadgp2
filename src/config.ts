
/**
 * إعدادات المسؤول (Admin Configuration)
 * يمكنك تعديل هذه القيم لتغيير هوية المسؤول في الموقع
 */
export const ADMIN_CONFIG = {
  // البريد الإلكتروني للمسؤول (يجب أن يطابق بريدك في جوجل)
  email: 'alwaelai2000@gmail.com',
  
  // الاسم الذي سيظهر للمستخدمين بدلاً من البريد الإلكتروني
  displayName: 'wael haider-it',
  
  // رابط صورة المسؤول (يمكنك وضع رابط لأي صورة تريدها هنا)
  // تم ضبطه ليبحث عن ملف باسم admin.png في مجلد public
  photoUrl: '/admin.png',
  
  // هل الموقع يستخدم Google Drive للرفع؟
  useGoogleDrive: true
};
