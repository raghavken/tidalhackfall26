`timescale 1ns/1ps
module tb_echo;
reg clk=0,reset_n=0,rx=1;
always #5 clk=~clk;
wire tx; wire [5:0] red; wire [7:0] green;
reg [7:0] bytes[0:58799];
wire [7:0] out_data; wire out_valid,out_error;
integer i,j,k,received=0;
top #(.CLOCK_HZ(1600000),.BAUD(100000)) dut(clk,reset_n,1'b1,rx,tx,red,green);
uart_rx #(.CLOCK_HZ(1600000),.BAUD(100000)) monitor(clk,reset_n,tx,out_data,out_valid,out_error);
always @(posedge clk) begin
 if(out_error) $fatal(1,"FAIL echo output framing");
 if(out_valid) begin
  if(out_data!==bytes[received]) $fatal(1,"FAIL echo %d got %h expected %h",received,out_data,bytes[received]);
  received=received+1;
 end
end
initial begin
 $readmemh("build/normal.hex",bytes);
 repeat(5) @(negedge clk); reset_n=1; repeat(16) @(negedge clk);
 for(i=0;i<112;i=i+1) begin
  rx=0; repeat(16) @(negedge clk);
  for(j=0;j<8;j=j+1) begin rx=bytes[i][j]; repeat(16) @(negedge clk); end
  rx=1; repeat(16) @(negedge clk);
 end
 k=0;
 while(received<112 && k<3000) begin @(negedge clk); k=k+1; end
 if(received!=112 || red[4]) $fatal(1,"FAIL echo count or error");
 $display("PASS UART echo original dataset bytes"); $finish;
end
initial begin #1000000; $fatal(1,"FAIL echo timeout"); end
endmodule
