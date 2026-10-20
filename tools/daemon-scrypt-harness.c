#include <stdio.h>
#include <stdlib.h>
#include <string.h>
void scrypt_1024_1_1_256(const char *input, char *output);
int main(){ char line[400]; while(fgets(line,sizeof line,stdin)){ unsigned char in[80],out[32]; for(int i=0;i<80;i++){unsigned v; sscanf(line+2*i,"%2x",&v); in[i]=v;} scrypt_1024_1_1_256((char*)in,(char*)out); for(int i=0;i<32;i++)printf("%02x",out[i]); printf("\n"); } }
